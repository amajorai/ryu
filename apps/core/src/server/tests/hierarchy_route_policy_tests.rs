use crate::authorization::{Capability, RoutePolicy};
use crate::server::route_policy;
use axum::http::Method;

#[test]
fn registered_hierarchy_operations_keep_their_chat_capability_gate() {
    for path in [
        "/api/hierarchy/main-threads",
        "/api/hierarchy/threads/main",
        "/api/hierarchy/threads/main/sessions",
        "/api/hierarchy/projects/project/threads",
    ] {
        for method in [Method::GET, Method::HEAD] {
            assert_eq!(
                route_policy(&method, path),
                RoutePolicy::requires([Capability::ChatRead]),
                "{method} {path}"
            );
        }
    }
    for (method, path) in [
        (Method::PUT, "/api/hierarchy/threads/main/project"),
        (Method::PUT, "/api/hierarchy/threads/main/coordination"),
    ] {
        assert_eq!(
            route_policy(&method, path),
            RoutePolicy::requires([Capability::ChatWrite]),
            "{method} {path}"
        );
    }
}

#[test]
fn unsupported_hierarchy_operations_and_scope_defaults_remain_owner_only() {
    for (method, path) in [
        (Method::POST, "/api/hierarchy/main-threads"),
        (Method::POST, "/api/hierarchy/threads/main/sessions"),
        (Method::DELETE, "/api/hierarchy/main-threads"),
        (Method::GET, "/api/hierarchy/threads/main/project"),
        (Method::PUT, "/api/hierarchy/threads//project"),
        (Method::GET, "/api/hierarchy/threads/main/unknown"),
        (Method::GET, "/api/hierarchy/projects/project/threads/extra"),
        (Method::PUT, "/api/scope-defaults/global"),
        (Method::DELETE, "/api/scope-defaults/agent%3Aworker"),
        (Method::GET, "/api/scope-guidance"),
        (Method::PUT, "/api/scope-guidance/project:atlas"),
        (Method::DELETE, "/api/scope-guidance/agent%3Aworker"),
    ] {
        assert_eq!(
            route_policy(&method, path),
            RoutePolicy::OwnerOnly,
            "{method} {path}"
        );
    }
}
