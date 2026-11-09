//! Catalog generation, the denylist and credential-write refusals.

use super::*;
// Module-private items, reached through the module that owns them.
use crate::self_api::denylist::{
    is_credential_write, DENIED_AGENT_ACCESS_WRITES, DENIED_CREDENTIAL_WRITE_EXACT,
    DENIED_CREDENTIAL_WRITE_PREFIXES, DENIED_EXACT, DENIED_PREFIXES,
};
use crate::self_api::gates::gateway_config_settings_only_section;
use crate::self_api::routes::slug;

#[test]
fn agents_cannot_write_credential_or_safety_sections_of_the_gateway_config() {
    let write = |body: Value| {
        gateway_config_settings_only_section("/api/gateway/config", "PUT", &json!({ "body": body }))
    };
    assert_eq!(write(json!({ "egress": { "pools": [] } })), Some("egress"));
    assert_eq!(write(json!({ "auth": { "api_keys": [] } })), Some("auth"));
    assert_eq!(
        write(json!({ "firewall": { "dlp": false } })),
        Some("firewall")
    );
    assert_eq!(
        write(json!({ "budgets": {}, "firewall_org_overlays": {} })),
        Some("firewall_org_overlays")
    );
    assert_eq!(
        write(json!({ "routing": {}, "budgets": {}, "cache": {} })),
        None
    );
    // Reads, and other routes, are not affected.
    assert_eq!(
        gateway_config_settings_only_section(
            "/api/gateway/config",
            "GET",
            &json!({ "body": { "egress": {} } })
        ),
        None
    );
    assert_eq!(
        gateway_config_settings_only_section(
            "/api/routing/policy",
            "PUT",
            &json!({ "body": { "egress": {} } })
        ),
        None
    );
}

#[test]
fn agents_cannot_allow_the_security_key_or_locked_use() {
    for body in [
        json!({ "computer_use": { "security_key": true } }),
        json!({ "budgets": {}, "computer_use": { "locked_use": true } }),
    ] {
        assert_eq!(
            gateway_config_settings_only_section(
                "/api/gateway/config",
                "PUT",
                &json!({ "body": body })
            ),
            Some("computer_use")
        );
    }
}

#[test]
fn slug_shape() {
    assert_eq!(slug("/api/quests"), "api_quests");
    assert_eq!(slug("/api/quests/{id}"), "api_quests_id");
    assert_eq!(slug("/api/mcp/servers/{name}"), "api_mcp_servers_name");
}

#[test]
fn ids_encode_method_and_slug() {
    let routes = build_routes(&sample_spec());
    let get = routes
        .iter()
        .find(|r| r.path_template == "/api/quests" && r.method == "GET")
        .unwrap();
    assert_eq!(get.id, "ryu_api.get_api_quests");
    assert_eq!(method_of(&get.id), Some("get"));
    assert!(!is_mutating(&get.id));

    let del = routes.iter().find(|r| r.method == "DELETE").unwrap();
    assert_eq!(del.id, "ryu_api.delete_api_quests_id");
    assert_eq!(method_of(&del.id), Some("delete"));
    assert!(is_mutating(&del.id));
    assert_eq!(del.path_params, vec!["id".to_string()]);
}

#[test]
fn post_carries_body_arg() {
    let routes = build_routes(&sample_spec());
    let post = routes.iter().find(|r| r.method == "POST").unwrap();
    assert!(post.has_body);
    let (names, _) = arg_summary(Some(&post.input_schema));
    assert!(names.iter().any(|n| n == "body"));
}

#[test]
fn query_param_becomes_arg_not_path() {
    let routes = build_routes(&sample_spec());
    let mem = routes
        .iter()
        .find(|r| r.path_template == "/api/memory")
        .unwrap();
    assert_eq!(mem.query_params, vec!["scope".to_string()]);
    assert!(mem.path_params.is_empty());
}

/// EVERY denylist entry must be absent from the generated catalog, at every
/// verb — this is the security contract.
#[test]
fn denylist_is_enforced_for_every_entry() {
    for prefix in DENIED_PREFIXES {
        for m in METHODS {
            assert!(is_denied(&format!("{prefix}whatever"), m), "{prefix} {m}");
        }
    }
    for exact in DENIED_EXACT {
        for m in METHODS {
            assert!(is_denied(exact, m), "{exact} {m}");
        }
    }
    assert!(is_denied("/api/mesh/peers", "get"));
    assert!(is_denied("/api/identities", "get"));
    assert!(is_denied("/api/identities/connections", "get"));
    assert!(is_denied("/api/vault/secrets", "get"));
    assert!(is_denied("/api/vault/secrets/name", "post"));
    assert!(is_denied("/api/rules/discover", "get"));
    assert!(is_denied("/api/webhooks/workflow-1/secret", "get"));
    assert!(is_denied("/api/webhooks/workflow-1/secret", "post"));
    // Streaming/WS routes are excluded.
    assert!(is_denied("/api/chat/stream", "post"));
    assert!(is_denied("/api/realtime_ws", "get"));
    assert!(is_denied("/api/notifications/stream", "get"));
    assert!(is_denied("/api/events/all", "get"));
    // Approvals: reads allowed, mutations denied (no self-approval).
    assert!(!is_denied("/api/approvals", "get"));
    assert!(is_denied("/api/approvals/approve", "post"));
    assert!(is_denied("/api/approvals/reject", "post"));
    // Agent-record and trigger-binding writes are denied: an agent must not
    // widen its own account access or bind itself to the user's accounts.
    for path in DENIED_AGENT_ACCESS_WRITES {
        for m in ["post", "put", "patch"] {
            assert!(is_denied(path, m), "{path} {m}");
        }
        assert!(!is_denied(path, "get"), "{path} get");
    }
    assert!(is_denied("/api/agents/{id}", "put"));
    assert!(is_denied("/api/agents", "post"));
    assert!(is_denied("/api/composio/targets", "post"));
    assert!(!is_denied("/api/agents/{id}/usage", "get"));
    // An agent's own Composio accounts are operator-only for every verb.
    for path in [
        "/api/agents/{id}/composio/connections",
        "/api/agents/{id}/composio/connections/initiate",
        "/api/agents/{id}/composio/connections/{cid}",
        "/api/agents/@scope/name/composio/connections",
    ] {
        for m in METHODS {
            assert!(is_denied(path, m), "{path} {m}");
        }
    }
    // Self-approval of chat permission prompts and tool-dispatch recursion
    // through the widget bridge or the per-agent MCP endpoint are denied.
    for path in [
        "/api/chat/permission",
        "/api/widgets/tools/call",
        "/api/widgets/open",
        "/mcp/{agent_id}",
    ] {
        for m in METHODS {
            assert!(is_denied(path, m), "{path} {m}");
        }
    }
    // Account connection and credential writes are denied for every
    // agent; their reads stay available.
    for prefix in DENIED_CREDENTIAL_WRITE_PREFIXES {
        for m in ["post", "put", "patch", "delete"] {
            assert!(is_denied(prefix, m), "{prefix} {m}");
            assert!(is_denied(&format!("{prefix}/x"), m), "{prefix}/x {m}");
        }
    }
    for exact in DENIED_CREDENTIAL_WRITE_EXACT {
        for m in ["post", "put", "patch", "delete"] {
            assert!(is_denied(exact, m), "{exact} {m}");
        }
    }
    for (method, path) in [
        ("post", "/api/composio/connections/initiate"),
        ("post", "/api/composio/connections/complete"),
        (
            "post",
            "/api/plugins/{plugin_id}/auth/{server_name}/connect",
        ),
        ("post", "/api/plugins/notion/auth/notion/connect"),
        ("delete", "/api/plugins/{plugin_id}/auth/{server_name}"),
        ("put", "/api/plugins/{id}/secrets/{key}"),
        ("delete", "/api/plugins/notion/secrets/token"),
        ("post", "/api/plugins/{id}/grants"),
        ("post", "/api/apps/{id}/grants"),
        ("post", "/api/apps/notion/grants"),
        ("put", "/api/pi-config"),
        ("post", "/api/pi-config/providers"),
        ("delete", "/api/pi-config/providers/model-enabled"),
        ("put", "/api/pi-config/providers/model-enabled"),
        ("put", "/api/pi-config/providers/{id}/account-pool"),
        ("post", "/api/pi-config/providers/openai/accounts/switch"),
        ("post", "/api/pi-config/providers/{id}/login"),
        ("post", "/api/pi-config/login/s1/complete"),
        ("put", "/api/gateway/providers"),
        ("post", "/api/agents/{id}/accounts/switch"),
        ("post", "/api/agents/{id}/accounts/remove"),
        ("post", "/api/agents/{id}/authenticate"),
        ("post", "/api/agents/{id}/native-accounts"),
        ("post", "/api/agents/a1/native-accounts/k1/login"),
        (
            "delete",
            "/api/agents/{id}/native-accounts/operations/{operation_id}",
        ),
        ("put", "/api/cloud-environments"),
        ("post", "/api/cloud-environments/github"),
        ("post", "/api/cloud-environments/import"),
        ("post", "/api/channels/managed-bot/pair"),
        ("post", "/api/channels/managed-bot/{nonce}/confirm"),
        ("delete", "/api/channels/managed-bot/{nonce}"),
        ("post", "/api/backups/recovery-key"),
        ("delete", "/api/composio/trigger-subscriptions/{id}"),
    ] {
        assert!(is_denied(path, method), "{method} {path}");
    }
    for path in [
        "/api/composio/connections",
        "/api/composio/connections/{id}",
        "/api/plugins/{plugin_id}/auth",
        "/api/plugins/{plugin_id}/auth/flows/{flow_id}",
        "/api/plugins/{id}/secrets",
        "/api/pi-config",
        "/api/pi-config/providers/{id}/accounts",
        "/api/agents/{id}/accounts",
        "/api/agents/{id}/native-accounts",
        "/api/cloud-environments",
        "/api/cloud-environments/github",
        "/api/composio/trigger-subscriptions",
    ] {
        assert!(!is_denied(path, "get"), "{path} get");
    }
    // Near misses stay available.
    assert!(!is_denied("/api/agents/{id}/usage", "get"));
    assert!(!is_denied("/api/pi-config/providers-extra", "post"));
    assert!(!is_denied("/api/pi-config/discover-models", "post"));
    // Toggling a model on or off is a setting, not a credential.
    assert!(!is_denied("/api/pi-config/providers/model-enabled", "post"));
    assert!(!is_denied("/api/apps/{id}/enable", "post"));
    assert!(!is_denied("/api/cloud-environments/{id}/launch", "post"));
    assert!(!is_denied(
        "/api/cloud-environments/shared/{id}/import",
        "post"
    ));
    assert!(!is_denied("/api/plugins/{id}/enable", "post"));
    assert!(!is_denied("/api/plugins/auth/enable", "post"));
    assert!(!is_denied("/api/agents/accounts/x", "post"));
    assert!(!is_denied("/api/composio/toolkits", "get"));
    assert!(!is_denied("/api/composio/status", "get"));
    // Sanity: an ordinary route is allowed.
    assert!(!is_denied("/api/quests", "get"));
    assert!(!is_denied("/api/quests", "post"));
}

/// No agent, restricted or not, can connect, re-key or remove one of the
/// user's accounts through the catalog. Guards against a refactor quietly
/// bringing one back.
#[test]
fn credential_writes_are_absent_from_the_catalog() {
    for r in routes() {
        assert!(
            !is_credential_write(&r.path_template, &r.method),
            "credential write in the catalog: {} {}",
            r.method,
            r.path_template
        );
    }
    for id in [
        "ryu_api.post_api_composio_connections_initiate",
        "ryu_api.post_api_composio_connections_complete",
        "ryu_api.post_api_plugins_plugin_id_auth_server_name_connect",
        "ryu_api.delete_api_plugins_plugin_id_auth_server_name",
        "ryu_api.put_api_plugins_id_secrets_key",
        "ryu_api.delete_api_plugins_id_secrets_key",
        "ryu_api.post_api_plugins_id_grants",
        "ryu_api.post_api_apps_id_grants",
        "ryu_api.post_api_pi_config_providers",
        "ryu_api.put_api_pi_config",
        "ryu_api.put_api_gateway_providers",
        "ryu_api.post_api_agents_id_native_accounts",
        "ryu_api.post_api_agents_id_accounts_switch",
        "ryu_api.post_api_agents_id_authenticate",
        "ryu_api.put_api_cloud_environments",
        "ryu_api.post_api_cloud_environments_github",
        "ryu_api.post_api_cloud_environments_import",
        "ryu_api.post_api_channels_managed_bot_pair",
        "ryu_api.post_api_backups_recovery_key",
        "ryu_api.delete_api_composio_trigger_subscriptions_id",
    ] {
        assert!(route_for(id).is_none(), "{id} is in the catalog");
    }
    // Their reads are still offered.
    for id in [
        "ryu_api.get_api_composio_connections",
        "ryu_api.get_api_pi_config",
        "ryu_api.get_api_plugins_plugin_id_auth",
        "ryu_api.get_api_agents_id_native_accounts",
        "ryu_api.post_api_pi_config_providers_model_enabled",
    ] {
        assert!(route_for(id).is_some(), "{id} is not in the catalog");
    }
}

/// The resolved-path re-check refuses a credential write even when a route
/// is handed to the sender directly, before any request is made.
#[tokio::test]
async fn send_request_refuses_resolved_credential_paths() {
    let route = CoreApiRoute {
        id: "ryu_api.post_api_plugins_plugin_id_auth_server_name_connect".to_owned(),
        method: "POST".to_owned(),
        path_template: "/api/plugins/{plugin_id}/auth/{server_name}/connect".to_owned(),
        summary: String::new(),
        path_params: vec!["plugin_id".to_owned(), "server_name".to_owned()],
        query_params: Vec::new(),
        has_body: false,
        input_schema: json!({ "type": "object" }),
    };
    let error = send_request(
        &reqwest::Client::new(),
        "http://127.0.0.1:9",
        None,
        &route,
        &json!({ "plugin_id": "notion", "server_name": "notion" }),
    )
    .await
    .unwrap_err();
    assert!(
        error.to_string().contains("resolved to a denied path"),
        "{error}"
    );
}
