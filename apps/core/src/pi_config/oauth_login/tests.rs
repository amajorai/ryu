use super::*;

fn plan_registration(client: &str, access: &str) -> super::super::chatgpt_plan::StoredAccount {
    super::super::chatgpt_plan::StoredAccount::from_value(&json!({
        "state": "connected", "type": "oauth", "flow": "chatgpt-plan",
        "access": access, "refresh": "synthetic-refresh", "expires": 1_900_000_000_000_u64,
        "clientId": client, "hostId": format!("urn:uuid:{}", uuid::Uuid::new_v4()),
        "issuer": "https://auth.openai.com", "subject": "same-subject",
        "idToken": "synthetic-id-token", "email": "same@example.com",
        "scopes": ["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"]
    }))
    .unwrap()
}

#[test]
fn native_registrations_are_sealed_and_reconnect_preserves_another_active_account() {
    crate::pi_config::tests::with_temp_dir(|| {
        let vault = super::super::accounts::AccountVault::in_memory().unwrap();
        let scope = super::super::accounts::provider_scope(super::super::CHATGPT_PLAN_AUTH_KEY);
        let first = plan_registration("oaiapp_first", "first-access");
        let second = plan_registration("oaiapp_second", "second-access");
        let first_id = store_plan_registration(&vault, &PlanLoginTarget::New, &first).unwrap();
        let second_id = store_plan_registration(&vault, &PlanLoginTarget::New, &second).unwrap();
        assert_eq!(vault.count(&scope).unwrap(), 2);
        assert!(!super::super::read_auth().contains_key(super::super::CHATGPT_PLAN_AUTH_KEY));
        let target = PlanLoginTarget::Existing {
            account_id: first_id.clone(),
            registration: first,
        };
        let renewed = plan_registration("oaiapp_first", "renewed-access");
        assert_eq!(
            store_plan_registration(&vault, &target, &renewed).unwrap(),
            first_id
        );
        assert_eq!(
            vault.active_info(&scope).unwrap().unwrap().account_id,
            second_id
        );
        assert_eq!(
            vault.credential(&scope, &first_id).unwrap().unwrap()["access"],
            "renewed-access"
        );
        assert_eq!(
            vault.credential(&scope, &second_id).unwrap().unwrap()["access"],
            "second-access"
        );
        let other = store_plan_registration(&vault, &target, &second).unwrap_err();
        assert_eq!(
            super::login_text::error_event(&other)["code"],
            "chatgpt_plan_other_registration"
        );
        vault.remove(&scope, &first_id).unwrap();
        let removed = store_plan_registration(&vault, &target, &renewed).unwrap_err();
        assert_eq!(
            super::login_text::error_event(&removed)["code"],
            "chatgpt_plan_account_removed"
        );
        assert_eq!(vault.count(&scope).unwrap(), 1);
    });
}

#[test]
fn completed_oauth_login_is_sealed_and_materialized_as_the_same_account() {
    crate::pi_config::tests::with_temp_dir(|| {
        let vault = super::super::accounts::AccountVault::in_memory().expect("vault");
        let credential = json!({
            "type": "oauth",
            "access": "test-access",
            "refresh": "test-refresh",
            "expires": 1_900_000_000_000_u64
        });
        store_credential_with_vault("anthropic", &credential, Some(&vault))
            .expect("store completed login");
        let scope = super::super::accounts::provider_scope("anthropic");
        assert_eq!(
            vault
                .active_credential(&scope)
                .expect("sealed account")
                .map(|(_, value)| value),
            Some(credential.clone())
        );
        assert_eq!(super::super::read_auth()["anthropic"], credential);

        let another = json!({"type":"oauth","access":"second-access","refresh":"second-refresh"});
        store_credential_with_vault("anthropic", &another, Some(&vault))
            .expect("add another login");
        assert_eq!(vault.count(&scope).expect("account count"), 2);
        assert_eq!(
            vault
                .active_credential(&scope)
                .expect("active account")
                .map(|(_, value)| value),
            Some(another.clone())
        );
        assert_eq!(super::super::read_auth()["anthropic"], another);
    });
}

/// A session with no child, for the bookkeeping the flow does around one.
fn bare_session() -> LoginSession {
    let (tx, _rx) = broadcast::channel(8);
    LoginSession {
        tx,
        history: Mutex::new(Vec::new()),
        stdin: tokio::sync::Mutex::new(None),
        child: Mutex::new(None),
        native_abort: Mutex::new(None),
        finished: AtomicBool::new(false),
        provider: "anthropic".to_owned(),
        stderr_tail: Mutex::new(VecDeque::new()),
    }
}

/// The stderr tail is what turns "exited before completing" from a dead end
/// into a diagnosis, so it has to keep the LAST lines (a Node crash prints
/// the useful `code:`/specifier after the stack) and stay bounded.
#[test]
fn the_stderr_tail_keeps_the_last_lines_in_order() {
    let session = bare_session();
    for i in 0..(STDERR_TAIL_LINES + 5) {
        session.push_stderr(format!("line {i}"));
    }
    let tail = session.recent_stderr();
    let lines: Vec<&str> = tail.lines().collect();
    assert_eq!(lines.len(), STDERR_TAIL_LINES, "the tail is bounded");
    assert_eq!(lines.first().copied(), Some("line 5"), "oldest dropped");
    assert_eq!(
        lines.last().copied(),
        Some(format!("line {}", STDERR_TAIL_LINES + 4).as_str()),
        "newest kept, in order"
    );
}

/// A cancelled session is finished the instant `cancel` returns, and saying
/// so twice changes nothing (the reader task calls `cancel` after the
/// registry already has).
///
/// This is the POSTCONDITION only, and it held under the old buggy ordering
/// too. The ordering itself is guarded by
/// [`cancelling_publishes_finished_before_it_touches_the_child`].
#[test]
fn cancelling_marks_the_session_finished() {
    let session = bare_session();
    assert!(!session.is_finished());
    session.cancel();
    assert!(session.is_finished());
    // Idempotent: the reader task calls this after the registry already has.
    session.cancel();
    assert!(session.is_finished());
}

/// `cancel` must publish `finished` BEFORE it reaches for the child, so the
/// reader task cannot see the killed child's stdout EOF while `finished` is
/// still `false` and report a deliberate cancellation as "the login flow
/// exited before completing" — the message that is supposed to mean the
/// bridge died on its own.
///
/// Asserting that ordering by racing the real reader task would be useless:
/// the buggy window is a couple of instructions wide against an OS signal
/// delivery, so it would pass under the bug almost every run. This uses the
/// `child` mutex as a deterministic interposition point instead. While the
/// test holds that lock, `cancel` is parked on it, and under the buggy order
/// the store is downstream of the park and therefore CANNOT have happened.
/// So a `false` reading here is proof of the bug, not of bad luck; the sleep
/// only bounds the other direction (giving the thread time to enter
/// `cancel`), and 200 ms is orders of magnitude more than an atomic store.
#[test]
fn cancelling_publishes_finished_before_it_touches_the_child() {
    let session = Arc::new(bare_session());
    let guard = session.child.lock().expect("take the child lock first");

    let canceller = Arc::clone(&session);
    let handle = std::thread::spawn(move || canceller.cancel());

    std::thread::sleep(std::time::Duration::from_millis(200));
    // Read before releasing: the whole point is what is observable WHILE
    // `cancel` is parked. Assert after the join so a failure cannot panic
    // with the lock held and poison it on the way out.
    let observed = session.is_finished();
    drop(guard);
    handle.join().expect("the cancelling thread must not panic");

    assert!(
        observed,
        "`cancel` reached the child before publishing `finished`; move \
         `self.finished.store(…)` back to the top of `cancel()`"
    );
    assert!(session.is_finished(), "and it stays finished afterwards");
}

/// A sleeper long enough to outlive any wait these tests use.
fn long_sleeper() -> tokio::process::Command {
    #[cfg(unix)]
    let mut command = {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg("sleep 30");
        c
    };
    // `timeout` refuses to run with redirected stdin ("input redirection is
    // not supported"), so it would exit instantly and false-pass; `ping`
    // sleeps without needing a console.
    #[cfg(windows)]
    let mut command = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/c", "ping", "-n", "31", "127.0.0.1"]);
        c
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

/// A child that outlives the exit-status wait must be KILLED, not dropped.
/// By that point it has been taken out of the session, so `cancel()` and the
/// 15-minute backstop can no longer reach it, and tokio does not kill on
/// drop — a survivor keeps the fixed OAuth callback port bound for the rest
/// of the machine's uptime and every later login 400s with `EADDRINUSE`.
#[tokio::test]
async fn a_child_that_outlives_the_status_wait_is_killed_not_dropped() {
    let mut child = long_sleeper().spawn().expect("spawn the sleeper");
    let status = reap_or_kill(&mut child, std::time::Duration::from_millis(50)).await;
    assert!(
        status.is_none(),
        "a child still running at the ceiling has no exit status to report"
    );
    // If the kill did not land this hangs for the sleeper's full 30 s.
    let reaped = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
        .await
        .expect("the kill must land, so the child is immediately reapable")
        .expect("wait on the killed child");
    assert!(
        !reaped.success(),
        "the child was killed, not left to finish on its own"
    );
}

/// The normal path is unchanged: a child that has already exited yields its
/// status, and nothing is killed.
#[tokio::test]
async fn a_child_that_already_exited_reports_its_status() {
    #[cfg(unix)]
    let mut command = tokio::process::Command::new("sh");
    #[cfg(unix)]
    command.arg("-c").arg("exit 3");
    #[cfg(windows)]
    let mut command = tokio::process::Command::new("cmd");
    #[cfg(windows)]
    command.args(["/c", "exit", "3"]);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    // Establish the fixture's already-exited state before exercising the
    // reap deadline, which must not include cold process startup.
    let exited = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
        .await
        .expect("the fixture must exit before exercising reaping")
        .expect("wait on the exited fixture");
    assert_eq!(exited.code(), Some(3));
    let status = reap_or_kill(&mut child, EXIT_STATUS_WAIT)
        .await
        .expect("an exited child reports a status");
    assert_eq!(
        status.code(),
        Some(3),
        "the real exit code reaches the user"
    );
}

/// Vendor stderr can include a token. Preserve useful fixed diagnostics
/// without reflecting arbitrary helper output to the UI.
#[test]
fn the_exit_message_classifies_stderr_without_reflecting_secrets() {
    assert_eq!(
        exit_message(None, ""),
        "the login flow exited before completing"
    );
    assert_eq!(
        exit_message(None, "  Cannot find package '@earendil-works/pi-ai'  "),
        "the login flow exited before completing — the managed Pi package could not be loaded"
    );
    assert_eq!(
        exit_message(None, "request failed; access_token=secret-value"),
        "the login flow exited before completing"
    );
}

/// The pi-ai OAuth provider id for a Ryu provider is its `auth.json` key.
/// These coincide by construction, and the login writes the credential under
/// exactly the key `provider_configured` reads — so if this mapping ever
/// drifts, a completed login would leave the card saying "Not connected".
#[test]
fn subscription_providers_map_to_their_auth_keys() {
    assert_eq!(oauth_provider_id("claude-pro-max"), Some("anthropic"));
    assert_eq!(oauth_provider_id("openai-codex"), Some("openai-codex"));
    assert_eq!(oauth_provider_id("chatgpt"), Some("openai-codex"));
    assert_eq!(oauth_provider_id("github-copilot"), Some("github-copilot"));
    assert_eq!(oauth_provider_id("kimi-coding"), Some("kimi-coding"));
    assert_eq!(oauth_provider_id("radius"), Some("radius"));
    assert_eq!(oauth_provider_id("openrouter"), Some("openrouter"));
    assert_eq!(oauth_provider_id("xai"), Some("xai"));
    // Not a login provider: an api-key provider has nothing to log into.
    assert_eq!(oauth_provider_id("openai"), None);
    assert_eq!(oauth_provider_id("nope"), None);
}

#[test]
fn every_login_account_has_a_pre_turn_refresh_lane() {
    for provider in super::super::PROVIDERS {
        if oauth_provider_id(provider.id).is_some() {
            assert!(
                super::super::OAUTH_REFRESH_KEYS.contains(&provider.auth_key),
                "{} has login but no refresh lane for {}",
                provider.id,
                provider.auth_key
            );
        }
    }
}

#[test]
fn subscription_oauth_classifier_excludes_oauth_capable_byok_providers() {
    for provider in [
        "openai-codex",
        "chatgpt",
        "claude-pro-max",
        "github-copilot",
        "kimi-coding",
        "radius",
    ] {
        assert!(is_subscription_oauth_provider(provider), "{provider}");
    }
    for provider in ["openrouter", "xai", "openai", "unknown"] {
        assert!(!is_subscription_oauth_provider(provider), "{provider}");
    }
}

/// The runtime probe must find an interpreter by its PLATFORM file name, not
/// by the bare literal. Probing `<dir>/node` is what made every Windows host
/// (where it is `node.exe`) answer "no JavaScript runtime found" and fail the
/// login with a 400 before the flow ever started. `sh`/`cmd` stand in for the
/// interpreters here because they are the only executables guaranteed to be
/// present on a CI box — the lookup is the same one.
#[test]
fn the_runtime_probe_resolves_by_platform_file_name() {
    #[cfg(unix)]
    let known = "sh";
    #[cfg(windows)]
    let known = "cmd";
    assert!(
        crate::sidecar::manifest_sidecar::which_on_path(known).is_some(),
        "the probe backing js_runtime cannot find {known}"
    );
    let missing =
        crate::sidecar::manifest_sidecar::which_on_path("definitely-not-a-real-runtime-xyz");
    assert!(missing.is_none());
}

/// A completed login must land in `auth.json` WITHOUT disturbing any other
/// provider's entry, and must be visible to the same check the provider card
/// renders from.
#[test]
fn storing_a_credential_connects_that_provider_and_preserves_others() {
    crate::pi_config::tests::with_temp_dir(|| {
        // A legacy plaintext entry (as an older build or Pi itself wrote it).
        super::super::ensure_dir().expect("config dir");
        super::super::write_secret_file(
            &super::super::auth_path(),
            r#"{"openai":{"type":"api_key","key":"sk-existing"}}"#,
        )
        .expect("seed api key");
        assert_eq!(
            super::super::subscription_login_present("claude-pro-max"),
            Some(false),
            "not connected before the login"
        );

        store_credential(
            "anthropic",
            &json!({ "type": "oauth", "access": "tok", "refresh": "ref" }),
        )
        .expect("store credential");

        assert_eq!(
            super::super::subscription_login_present("claude-pro-max"),
            Some(true),
            "the card flips to Connected off the stored credential"
        );
        // The unrelated api-key entry survives the merge.
        let auth = super::super::read_auth();
        assert_eq!(
            auth.get("openai")
                .and_then(|v| v.get("key"))
                .and_then(|v| v.as_str()),
            Some("sk-existing")
        );
    });
}

#[test]
fn claude_login_and_anthropic_api_key_report_separate_connection_states() {
    crate::pi_config::tests::with_temp_dir(|| {
        super::super::ensure_dir().expect("config dir");
        super::super::write_secret_file(
            &super::super::auth_path(),
            r#"{"anthropic":{"type":"api_key","key":"sk-test"}}"#,
        )
        .expect("seed API key");
        assert_eq!(
            super::super::subscription_login_present("claude-pro-max"),
            Some(false),
            "an Anthropic API key must not claim a Claude subscription login"
        );

        store_credential(
            "anthropic",
            &json!({ "type": "oauth", "access": "tok", "refresh": "ref" }),
        )
        .expect("store OAuth login");
        assert_eq!(
            super::super::subscription_login_present("claude-pro-max"),
            Some(true)
        );
        assert!(
            !super::super::provider_configured(
                super::super::provider_meta("anthropic").expect("API-key row")
            ),
            "an OAuth login must not claim an Anthropic API key"
        );
    });
}

#[test]
fn refreshed_claude_expiry_is_written_in_both_core_and_pi_units() {
    crate::pi_config::tests::with_temp_dir(|| {
        store_credential(
            "anthropic",
            &json!({ "type": "oauth", "access": "old", "refresh": "old-refresh", "expires": 1 }),
        )
        .expect("seed OAuth login");
        super::super::persist_oauth_refresh(
            "anthropic",
            &super::super::read_auth()["anthropic"],
            None,
            "new",
            Some("new-refresh"),
            Some(1_900_000_000),
        )
        .expect("persist refresh");
        let credential = super::super::read_auth()
            .remove("anthropic")
            .expect("stored credential");
        assert_eq!(credential["expires_at"], json!(1_900_000_000));
        assert_eq!(credential["expires"], json!(1_900_000_000_000_u64));
        assert_eq!(credential["refresh"], json!("new-refresh"));
    });
}

#[test]
fn refreshed_claude_token_replaces_only_the_active_sealed_account() {
    crate::pi_config::tests::with_temp_dir(|| {
        let vault = super::super::accounts::AccountVault::in_memory().expect("vault");
        let scope = super::super::accounts::provider_scope("anthropic");
        let first = json!({ "type": "oauth", "access": "first", "refresh": "first-refresh" });
        let second = json!({ "type": "oauth", "access": "second", "refresh": "second-refresh" });
        vault
            .upsert(
                &scope,
                "account-a",
                "First",
                super::super::accounts::KIND_OAUTH,
                Some(first.clone()),
            )
            .expect("first account");
        vault
            .upsert(
                &scope,
                "account-b",
                "Second",
                super::super::accounts::KIND_OAUTH,
                Some(second.clone()),
            )
            .expect("second account");
        store_credential("anthropic", &second).expect("materialized active account");

        super::super::persist_oauth_refresh_with_vault(
            "anthropic",
            &second,
            Some("account-b"),
            "rotated",
            Some("rotated-refresh"),
            Some(1_900_000_000),
            Some(&vault),
        )
        .expect("persist rotated credential");

        assert_eq!(vault.credential(&scope, "account-a").unwrap(), Some(first));
        let rotated = vault
            .credential(&scope, "account-b")
            .unwrap()
            .expect("active account credential");
        assert_eq!(rotated["access"], json!("rotated"));
        assert_eq!(rotated["refresh"], json!("rotated-refresh"));
        assert_eq!(rotated["expires"], json!(1_900_000_000_000_u64));
        assert_eq!(super::super::read_auth()["anthropic"], rotated);
    });
}

#[test]
fn builtin_catalog_maps_api_keys_without_advertising_oauth() {
    for id in [
        "baseten",
        "ant-ling",
        "minimax-cn",
        "moonshotai-cn",
        "opencode",
        "opencode-go",
        "qwen-token-plan",
        "qwen-token-plan-cn",
        "qwen-token-plan-individual",
        "vercel-ai-gateway",
        "xiaomi",
        "xiaomi-token-plan-ams",
        "xiaomi-token-plan-cn",
        "xiaomi-token-plan-sgp",
        "zai-coding-cn",
    ] {
        assert_eq!(builtin_catalog_provider_id(id), Some(id));
        assert_eq!(oauth_provider_id(id), None);
    }
    assert_eq!(
        builtin_catalog_provider_id("claude-pro-max"),
        Some("anthropic")
    );
    assert_eq!(builtin_catalog_provider_id("custom-unknown"), None);
    assert_eq!(
        builtin_catalog_provider_id(crate::pi_config::GATEWAY_PROVIDER_ID),
        None
    );
}

#[test]
fn native_login_events_carry_core_messages_beside_their_english() {
    use super::login_text::{
        auth_url_event, error_event, error_event_or, message_event, PlanLoginFailure,
    };
    use crate::i18n::{messages, Message};

    let kiro = auth_url_event(
        "https://view.awsapps.com/start",
        &Message::new(messages::LOGIN_KIRO_INSTRUCTIONS_MESSAGE).text("code", "ABCD-EFGH"),
    );
    assert_eq!(kiro["type"], "auth_url");
    assert_eq!(
        kiro["instructions"],
        "Sign in with AWS Builder ID. Enter code ABCD-EFGH if requested."
    );
    assert_eq!(
        kiro["i18n"]["message"],
        "Sign in with AWS Builder ID. Enter code {code} if requested."
    );
    assert_eq!(kiro["i18n"]["args"]["code"], "ABCD-EFGH");

    let expired = message_event("info", &Message::new(messages::LOGIN_CODE_EXPIRED_MESSAGE));
    assert_eq!(expired["message"], expired["i18n"]["message"]);

    let failure = error_event(&anyhow::Error::new(PlanLoginFailure::RegistrationChanged));
    assert_eq!(failure["type"], "error");
    assert_eq!(failure["code"], "chatgpt_plan_registration_changed");
    assert_eq!(
        failure["message"],
        "The saved ChatGPT registration changed during sign-in. Try signing in again."
    );
    assert_eq!(failure["i18n"]["message"], failure["message"]);

    // A protocol error Core has no sentence for becomes the generic coded
    // message; its raw text is never sent.
    let other = error_event(&anyhow!("upstream refused the code"));
    assert_eq!(other["code"], "chatgpt_plan_sign_in_failed");
    assert_eq!(
        other["message"],
        "ChatGPT sign-in could not be completed. Start again."
    );
    assert_eq!(other["i18n"]["message"], other["message"]);
    assert!(!other.to_string().contains("upstream refused"));

    // The flow's own typed failures keep their sentence and code.
    let timed_out = error_event(&anyhow::Error::new(
        crate::pi_config::chatgpt_plan::SignInFailure::TimedOut,
    ));
    assert_eq!(timed_out["code"], "chatgpt_plan_timed_out");
    assert_eq!(
        timed_out["i18n"]["message"],
        "ChatGPT sign-in timed out. Start again."
    );
    let declined = error_event(
        &anyhow::Error::new(crate::pi_config::chatgpt_plan::SignInFailure::Declined)
            .context("while completing sign-in"),
    );
    assert_eq!(declined["code"], "chatgpt_plan_declined");

    // Kiro falls back to its own sentence and keeps its typed failures.
    let kiro = error_event_or(
        &anyhow!("vault write failed"),
        PlanLoginFailure::KiroSaveFailed,
    );
    assert_eq!(kiro["code"], "kiro_sign_in_failed");
    assert_eq!(
        kiro["message"],
        "Kiro sign-in could not be saved. Try signing in again."
    );
    let changed = error_event_or(
        &anyhow::Error::new(PlanLoginFailure::KiroLoginChanged),
        PlanLoginFailure::KiroSaveFailed,
    );
    assert_eq!(changed["code"], "kiro_login_changed");
    for failure in [
        PlanLoginFailure::RegistrationNotSaved,
        PlanLoginFailure::VaultRequired,
        PlanLoginFailure::KiroOtherProfile,
    ] {
        let event = error_event(&anyhow::Error::new(failure));
        assert_eq!(event["code"], failure.code());
        assert_eq!(event["i18n"]["message"], event["message"]);
    }
}

#[test]
fn a_failed_chatgpt_start_answers_with_the_generic_sentence_not_the_protocol_detail() {
    use super::login_text::{plan_start_failure, PlanLoginFailure};
    let protocol = plan_start_failure(anyhow!("discovery returned 502 from auth.openai.com"));
    assert_eq!(
        protocol.downcast_ref::<PlanLoginFailure>(),
        Some(&PlanLoginFailure::ChatGptFailed)
    );
    assert_eq!(
        protocol.to_string(),
        "ChatGPT sign-in could not be completed. Start again."
    );
    let known = plan_start_failure(anyhow::Error::new(PlanLoginFailure::RegistrationNotSaved));
    assert_eq!(
        known.downcast_ref::<PlanLoginFailure>(),
        Some(&PlanLoginFailure::RegistrationNotSaved)
    );
}
