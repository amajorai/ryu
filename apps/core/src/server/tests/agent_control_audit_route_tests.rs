use crate::server::agent_control_audit_route;
use axum::http::Method;

#[test]
fn keeps_agent_identity_and_action_in_the_control_row() {
    assert_eq!(
        agent_control_audit_route(&Method::PUT, "/api/agents/support"),
        Some((
            "agent.update".to_owned(),
            "agent:support".to_owned(),
            Some("support".to_owned()),
        ))
    );
    assert_eq!(
        agent_control_audit_route(
            &Method::POST,
            "/api/agents/support/prompt-versions/3/restore"
        ),
        Some((
            "agent.prompt-version.restore".to_owned(),
            "agent:support".to_owned(),
            Some("support".to_owned()),
        ))
    );
}

#[test]
fn leaves_reads_and_agent_creation_for_the_handler_with_the_new_id() {
    assert_eq!(
        agent_control_audit_route(&Method::GET, "/api/agents/support"),
        None
    );
    assert_eq!(
        agent_control_audit_route(&Method::POST, "/api/agents"),
        None
    );
}
