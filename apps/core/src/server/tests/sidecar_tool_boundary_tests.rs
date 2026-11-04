use crate::server::SidecarToolCall;

#[test]
fn identity_and_policy_are_not_sidecar_arguments() {
    let valid = serde_json::json!({"tool":"example.list", "agentId":"ryu", "arguments":{}});
    assert!(serde_json::from_value::<SidecarToolCall>(valid.clone()).is_ok());
    for field in [
        "userId",
        "user_id",
        "hostConversationId",
        "identityProfileIds",
        "mcpAllowlist",
    ] {
        let mut spoofed = valid.clone();
        spoofed[field] = serde_json::json!("other-user");
        assert!(
            serde_json::from_value::<SidecarToolCall>(spoofed).is_err(),
            "accepted {field}"
        );
    }
}
