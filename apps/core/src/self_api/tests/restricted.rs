//! Restricted-account agents, path-segment safety, and the tenancy gate.

use super::*;
// Module-private items, reached through the module that owns them.
use crate::self_api::loopback::is_safe_path_segment;
use crate::self_api::restricted::RESTRICTED_SAFE_WRITES;

/// Every reviewed safe write is a real catalog route, so the list cannot
/// silently drift from the routes it names, and none of them reaches a
/// sharing, credential, connection, agent or run surface.
#[test]
fn restricted_safe_writes_are_real_reviewed_routes() {
    const FORBIDDEN_SEGMENTS: &[&str] = &[
        "access",
        "visibility",
        "export",
        "import",
        "secrets",
        "auth",
        "accounts",
        "connections",
        "participants",
        "fork",
        "regenerate",
        "edit",
        "pull-requests",
        "duplicate",
        "settings",
        "tools",
    ];
    let mut seen = HashSet::new();
    for (method, path) in RESTRICTED_SAFE_WRITES {
        assert!(
            seen.insert((*method, *path)),
            "duplicate entry {method} {path}"
        );
        assert_ne!(*method, "GET", "{path}: reads need no entry");
        assert!(
            routes()
                .iter()
                .any(|r| r.method == *method && r.path_template == *path),
            "{method} {path} is not a CoreApi route; remove or fix the entry"
        );
        // Editing a stored run record is fine; starting a run is not.
        assert!(!path.ends_with("/runs"), "{method} {path} starts a run");
        for segment in path.split('/') {
            assert!(
                !FORBIDDEN_SEGMENTS.contains(&segment),
                "{method} {path} reaches a refused category ({segment})"
            );
        }
    }
}

/// The real catalog: a restricted agent may make exactly the reviewed writes,
/// and every other write (including any route added later) is refused.
#[test]
fn restricted_agents_are_held_to_the_reviewed_writes() {
    let mut allowed = 0;
    for r in routes() {
        let listed = RESTRICTED_SAFE_WRITES
            .iter()
            .any(|(m, p)| *m == r.method && *p == r.path_template);
        let refusal = restricted_write_refusal(&r.id);
        if r.method == "GET" {
            assert!(refusal.is_none(), "read refused: {}", r.path_template);
        } else if listed {
            allowed += 1;
            assert!(
                refusal.is_none(),
                "reviewed write refused: {} {}",
                r.method,
                r.path_template
            );
        } else {
            assert!(
                refusal.is_some(),
                "unreviewed write allowed: {} {}",
                r.method,
                r.path_template
            );
        }
    }
    assert_eq!(allowed, RESTRICTED_SAFE_WRITES.len());
}

#[test]
fn restricted_agents_keep_workspace_writes() {
    for id in [
        "ryu_api.post_api_spaces_id_documents",
        "ryu_api.put_api_memory_id",
        "ryu_api.post_api_conversations_id_title",
        "ryu_api.post_api_notifications_id_ack",
        "ryu_api.get_api_composio_connections",
    ] {
        assert!(route_for(id).is_some(), "{id} is not in the catalog");
        assert_eq!(restricted_write_refusal(id), None, "{id}");
    }
}

/// Reviewing Dream proposals (accept, reject, undo) is open to restricted
/// agents through exactly the same matching as every other reviewed write,
/// and no other memory write or `rollback` route comes with it.
#[test]
fn restricted_agents_review_dream_proposals_and_nothing_broader() {
    for id in [
        "ryu_api.post_api_memory_dream_review_proposals_id_accept",
        "ryu_api.post_api_memory_dream_review_proposals_id_reject",
        "ryu_api.post_api_memory_dream_review_proposals_id_rollback",
    ] {
        assert!(route_for(id).is_some(), "{id} is not in the catalog");
        assert_eq!(restricted_write_refusal(id), None, "{id}");
    }
    let rollback = "/api/memory/dream/review/proposals/{id}/rollback";
    assert!(restricted_agent_may_write(rollback, "POST"));
    assert!(restricted_agent_may_write(rollback, "post"));
    for method in ["PUT", "PATCH", "DELETE"] {
        assert!(!restricted_agent_may_write(rollback, method), "{method}");
    }
    // Templates match exactly: a resolved path, a prefix or an extension is
    // not the reviewed route.
    for path in [
        "/api/memory/dream/review/proposals/p1/rollback",
        "/api/memory/dream/review/proposals/{id}",
        "/api/memory/dream/review/proposals/{id}/rollback/extra",
        "/api/memory/dream/review/rollback",
        "/api/plugins/{id}/rollback",
        "/api/vault/secrets/{name}/rollback",
    ] {
        assert!(!restricted_agent_may_write(path, "POST"), "{path}");
    }
    // Across the real catalog, the only memory writes a restricted agent may
    // make are editing an entry and reviewing a proposal, and the Dream
    // rollback is the only `rollback` route it may call.
    let mut memory_writes = Vec::new();
    for r in routes() {
        if r.method == "GET" || restricted_write_refusal(&r.id).is_some() {
            continue;
        }
        if r.path_template.starts_with("/api/memory") {
            memory_writes.push(format!("{} {}", r.method, r.path_template));
        }
        if r.path_template.ends_with("/rollback") {
            assert_eq!(r.path_template, rollback, "{}", r.method);
        }
    }
    memory_writes.sort();
    assert_eq!(
        memory_writes,
        [
            "POST /api/memory/dream/review/proposals/{id}/accept",
            "POST /api/memory/dream/review/proposals/{id}/reject",
            "POST /api/memory/dream/review/proposals/{id}/rollback",
            "PUT /api/memory/{id}",
        ]
    );
}

#[test]
fn restricted_agents_are_refused_access_routes() {
    for id in [
        "ryu_api.post_v1_chat_completions",
        "ryu_api.post_api_actions_action_id",
        "ryu_api.post_api_conversations_id_participants",
        "ryu_api.put_api_spaces_id_documents_doc_id_access",
        "ryu_api.post_api_spaces_id_visibility",
        "ryu_api.post_heartbeat_jobs",
        "ryu_api.post_api_images_generate",
        "ryu_api.put_api_memory_settings",
    ] {
        assert!(route_for(id).is_some(), "{id} is not in the catalog");
        let reason = restricted_write_refusal(id).unwrap_or_else(|| panic!("{id} allowed"));
        assert!(reason.contains("account access does not allow"), "{reason}");
    }
    // Denied for everyone, so absent from the catalog; still refused here.
    for (method, path) in [
        ("POST", "/mcp/{agent_id}"),
        ("POST", "/api/widgets/tools/call"),
        ("POST", "/api/widgets/open"),
        ("PUT", "/api/agents/{id}"),
        ("PUT", "/api/plugins/{id}/secrets/{key}"),
        ("DELETE", "/api/plugins/{id}/secrets/{key}"),
        ("POST", "/api/pi-config/providers"),
        ("POST", "/api/composio/connections/initiate"),
    ] {
        assert!(!restricted_agent_may_write(path, method), "{method} {path}");
    }
}

#[test]
fn restricted_agents_create_only_private_spaces() {
    let Some(route) = routes()
        .iter()
        .find(|r| r.method == "POST" && r.path_template == "/api/spaces")
    else {
        panic!("POST /api/spaces is in the spec");
    };
    for body in [
        json!({}),
        json!({ "body": { "name": "n" } }),
        json!({ "body": { "visibility": "private" } }),
    ] {
        assert_eq!(restricted_sharing_refusal(&route.id, &body), None, "{body}");
    }
    for visibility in ["org", "team"] {
        let arguments = json!({ "body": { "name": "n", "visibility": visibility } });
        assert!(restricted_sharing_refusal(&route.id, &arguments).is_some());
    }
}

#[test]
fn restricted_write_refusal_unknown_tool_fails_closed() {
    assert!(restricted_write_refusal("ryu_api.post_nope").is_some());
    assert!(restricted_write_refusal("ryu_api.delete_api_spaces_nope").is_some());
    assert!(restricted_write_refusal("ryu_api__post_nope").is_some());
    // Reads and non-CoreApi ids are not this gate's business.
    assert!(restricted_write_refusal("ryu_api.get_nope").is_none());
}

#[test]
fn path_segment_rejects_traversal_and_encoding() {
    // Safe: ordinary ids.
    assert!(is_safe_path_segment("abc123"));
    assert!(is_safe_path_segment("conv-42_x.y"));
    // Unsafe: separators, traversal, percent-encoding, control chars, empty.
    assert!(!is_safe_path_segment(""));
    assert!(!is_safe_path_segment("../auth/token"));
    assert!(!is_safe_path_segment("a/b"));
    assert!(!is_safe_path_segment("a\\b"));
    assert!(!is_safe_path_segment("conversation#"));
    assert!(!is_safe_path_segment("conversation?view=messages"));
    assert!(!is_safe_path_segment(".."));
    assert!(!is_safe_path_segment("..%2fauth"));
    assert!(!is_safe_path_segment("%2e%2e"));
    assert!(!is_safe_path_segment("a\nb"));
    assert!(!is_safe_path_segment("a\0b"));
}

/// The app host-capability bridge carries user-aware operations (Safe Actions
/// review, webhook secrets); a node-token loopback must never reach it.
#[test]
fn host_bridge_is_denied() {
    for path in [
        "/api/plugins/{id}/host",
        "/api/plugins/{plugin_id}/host",
        "/api/plugins/{id}/host/stream",
        "/api/plugins/@ryu/safe-actions/host",
        "/api/plugins/@ryu/webhooks/host/stream",
        "/api/plugins/com.ryu.webhooks/host",
    ] {
        for m in METHODS {
            assert!(is_denied(path, m), "{path} {m}");
        }
    }
    // Unrelated plugin routes stay available (taken from the real spec).
    assert!(!is_denied("/api/plugins/{id}/ui-bundle", "get"));
    assert!(!is_denied("/api/plugins/{id}/enable", "post"));
    assert!(!is_denied("/api/plugins/catalog", "get"));
    // A plugin whose id is literally `host` keeps its own lifecycle routes.
    assert!(!is_denied("/api/plugins/host/enable", "post"));
}

/// The real generated catalog must never contain a denylisted route.
#[test]
fn generated_catalog_excludes_denylisted_routes() {
    for r in routes() {
        let m = r.method.to_ascii_lowercase();
        assert!(
            !is_denied(&r.path_template, &m),
            "denylisted route leaked into catalog: {} {}",
            r.method,
            r.path_template
        );
        // And no id collides.
    }
    // The app host bridge is in the OpenAPI document; it must never become a
    // CoreApi tool, whatever its path parameter is named.
    assert!(
        !routes()
            .iter()
            .any(|r| r.path_template.starts_with("/api/plugins/")
                && (r.path_template.ends_with("/host") || r.path_template.contains("/host/"))),
        "the app host bridge leaked into the CoreApi catalog"
    );
    // An agent's own Composio accounts are in the OpenAPI document but must
    // never become CoreApi tools an agent could call on itself.
    assert!(
        !routes()
            .iter()
            .any(|r| r.path_template.starts_with("/api/agents/")
                && r.path_template
                    .split('/')
                    .any(|segment| segment == "composio")),
        "an agent's own Composio routes leaked into the CoreApi catalog"
    );
    // No duplicate ids.
    let mut ids: Vec<&str> = routes().iter().map(|r| r.id.as_str()).collect();
    let n = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(
        ids.len(),
        n,
        "duplicate core-api tool ids in generated catalog"
    );
}

#[test]
fn tenancy_refuses_when_bound() {
    // Unbound / personal (Unrestricted principal) → allowed.
    assert!(refuse_reason_if_tenant_bound(true).is_none());
    // Org-bound (not Unrestricted) → refused.
    assert!(refuse_reason_if_tenant_bound(false).is_some());
}
