use super::*;
#[tokio::test]
async fn device_progress_retains_instructions_without_losing_the_process() {
    let id = uuid::Uuid::new_v4().to_string();
    let (cancel, _) = watch::channel(false);
    operations().lock().await.insert(
        id.clone(),
        Operation {
            agent_id: "agent-a".into(),
            owner: None,
            created: std::time::Instant::now(),
            cancel,
            progress: Progress {
                operation_id: id.clone(),
                account_id: "account-a".into(),
                state: "running".into(),
                instructions: String::new(),
                error: None,
                error_code: None,
                error_i18n: None,
            },
        },
    );
    collect_instructions(
        &b"Open the device login page and enter the code"[..],
        id.clone(),
    )
    .await
    .unwrap();
    let mut store = operations().lock().await;
    let operation = store.remove(&id).unwrap();
    assert_eq!(operation.agent_id, "agent-a");
    assert!(operation.progress.instructions.contains("device login"));
    assert_eq!(operation.progress.state, "running");
}
#[tokio::test]
async fn oversized_login_instructions_fail_with_bounded_retention() {
    let id = uuid::Uuid::new_v4().to_string();
    let output = vec![b'x'; 20 * 1024];
    assert!(collect_instructions(output.as_slice(), id).await.is_err());
}

#[test]
fn login_progress_and_cancellation_require_the_original_owner_and_agent() {
    use crate::identity_verify::{OrgRole, VerifiedCaller};
    let caller = |user: &str, org: &str| {
        Some(VerifiedCaller {
            user_id: user.into(),
            org_id: Some(org.into()),
            email: None,
            email_verified: false,
            role: OrgRole::Viewer,
            teams: Vec::new(),
        })
    };
    let (cancel, _) = watch::channel(false);
    let operation = Operation {
        agent_id: "agent-a".into(),
        owner: owner(&caller("a", "org-a")),
        created: std::time::Instant::now(),
        cancel,
        progress: Progress {
            operation_id: "op".into(),
            account_id: "account".into(),
            state: "running".into(),
            instructions: "code".into(),
            error: None,
            error_code: None,
            error_i18n: None,
        },
    };
    assert!(visible(&operation, "agent-a", &caller("a", "org-a")));
    assert!(!visible(&operation, "agent-a", &caller("b", "org-a")));
    assert!(!visible(&operation, "agent-a", &caller("a", "org-b")));
    assert!(!visible(&operation, "agent-b", &caller("a", "org-a")));
    assert!(!visible(&operation, "agent-a", &None));
}

#[tokio::test]
async fn removing_or_disconnecting_account_signals_its_login_operation() {
    let id = uuid::Uuid::new_v4().to_string();
    let (cancel, mut receiver) = watch::channel(false);
    operations().lock().await.insert(
        id.clone(),
        Operation {
            agent_id: id.clone(),
            owner: None,
            created: std::time::Instant::now(),
            cancel,
            progress: Progress {
                operation_id: id.clone(),
                account_id: id.clone(),
                state: "running".into(),
                instructions: String::new(),
                error: None,
                error_code: None,
                error_i18n: None,
            },
        },
    );
    let signal_id = id.clone();
    let listener = tokio::spawn(async move {
        receiver.changed().await.unwrap();
        assert!(*receiver.borrow());
        operations()
            .lock()
            .await
            .get_mut(&signal_id)
            .unwrap()
            .progress
            .state = "failed".into();
    });
    cancel_account(&id, &id).await;
    listener.await.unwrap();
    operations().lock().await.remove(&id);
}

#[test]
fn failures_are_coded_core_messages_without_raw_detail() {
    let body = NativeAccountError::DisconnectFirst.body();
    assert_eq!(body["code"], "native_account_disconnect_first");
    assert_eq!(
        body["error"],
        "Disconnect this native account before signing in again."
    );
    assert_eq!(body["i18n"]["message"], body["error"]);

    // An internal failure collapses into the generic sentence.
    let internal = anyhow::anyhow!("Custody home escapes account root");
    assert_eq!(
        NativeAccountError::of(&internal),
        NativeAccountError::Failed
    );
    let response = failure(&internal);
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    // A typed failure survives added context.
    let wrapped = anyhow::Error::new(NativeAccountError::LoginTimedOut).context("while signing in");
    assert_eq!(
        NativeAccountError::of(&wrapped),
        NativeAccountError::LoginTimedOut
    );

    // Unsupported keeps the exact English older desktops match on.
    assert_eq!(
        NativeAccountError::Unsupported.body()["error"],
        "This agent does not support native account custody"
    );
}

#[test]
fn failed_login_progress_carries_the_coded_message() {
    let mut progress = Progress {
        operation_id: "op".into(),
        account_id: "account".into(),
        state: "failed".into(),
        instructions: String::new(),
        error: None,
        error_code: None,
        error_i18n: None,
    };
    let idle = serde_json::to_value(&progress).unwrap();
    assert!(idle.get("errorCode").is_none() && idle.get("errorI18n").is_none());
    progress.fail(NativeAccountError::LoginCancelled);
    let failed = serde_json::to_value(&progress).unwrap();
    assert_eq!(failed["error"], "Native sign-in was cancelled.");
    assert_eq!(failed["errorCode"], "native_account_login_cancelled");
    assert_eq!(failed["errorI18n"]["message"], failed["error"]);
}
