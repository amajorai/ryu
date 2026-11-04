use super::*;

#[tokio::test]
async fn persisted_denied_agent_acl_skips_acp_and_vault_operations() {
    let _lock = ACL_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let _restore = install_agent_acl();
    let bob = member("bob");
    for permission in [
        crate::identity_verify::permissions::AGENT_VIEW,
        crate::identity_verify::permissions::AGENT_EDIT,
    ] {
        let decision = crate::acl::decide_with_context(
            &bob,
            crate::acl::KIND_AGENT,
            PERSISTED_AGENT_ID,
            permission,
            &std::collections::HashSet::new(),
            &std::collections::HashSet::new(),
        );
        assert_eq!(decision, crate::acl::Decision::Denied);

        let operation_calls = Arc::new(AtomicUsize::new(0));
        let calls = Arc::clone(&operation_calls);
        let result = run_after_agent_resource_permission(
            async move {
                match decision {
                    crate::acl::Decision::Allowed => Ok(()),
                    crate::acl::Decision::Denied => Err(json_error(
                        StatusCode::FORBIDDEN,
                        format!("insufficient permissions: {permission}"),
                    )),
                }
            },
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                "side effect"
            },
        )
        .await;

        let response = result.expect_err("a denied resource ACL must stop the operation");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            operation_calls.load(Ordering::SeqCst),
            0,
            "ACP spawn or vault access must not run after an ACL denial"
        );
    }
}

#[tokio::test]
async fn persisted_allowed_agent_acl_runs_the_operation_once() {
    let _lock = ACL_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let _restore = install_agent_acl();
    let carol = member("carol");
    let permission = crate::identity_verify::permissions::AGENT_VIEW;
    let decision = crate::acl::decide_with_context(
        &carol,
        crate::acl::KIND_AGENT,
        PERSISTED_AGENT_ID,
        permission,
        &std::collections::HashSet::new(),
        &std::collections::HashSet::new(),
    );
    assert_eq!(decision, crate::acl::Decision::Allowed);

    let operation_calls = Arc::new(AtomicUsize::new(0));
    let calls = Arc::clone(&operation_calls);
    let result = run_after_agent_resource_permission(
        async move {
            match decision {
                crate::acl::Decision::Allowed => Ok(()),
                crate::acl::Decision::Denied => Err(json_error(
                    StatusCode::FORBIDDEN,
                    format!("insufficient permissions: {permission}"),
                )),
            }
        },
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            "completed"
        },
    )
    .await
    .expect("an allowed resource ACL should run the operation");

    assert_eq!(result, "completed");
    assert_eq!(operation_calls.load(Ordering::SeqCst), 1);
}
