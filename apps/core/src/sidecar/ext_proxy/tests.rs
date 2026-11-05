//! Tests for the ext proxy, one file per area.

use super::*;

mod caller_headers;
mod forward_stamps;
mod forwarding;
mod host_calls;
mod kernel_table;
mod manifests;
mod permissions;
mod public_mount_policy;
mod public_mounts;
mod rate_subject;
mod route_resolution;
mod web_admission;
mod web_delegation_facts;
mod ws_lane;

// Fixtures shared by more than one area.

fn route(
    path: &str,
    permission: Option<&str>,
    resource_param: Option<&str>,
) -> crate::plugin_manifest::schema::RouteSpec {
    crate::plugin_manifest::schema::RouteSpec {
        path: path.to_owned(),
        method: None,
        auth: Default::default(),
        permission: permission.map(str::to_owned),
        resource_param: resource_param.map(str::to_owned),
    }
}

fn provider_manifest(port: u16, mount: Option<&str>) -> crate::plugin_manifest::PluginManifest {
    use crate::plugin_manifest::schema::{
        BinarySpec, HttpProxySpec, RouteSpec, SidecarProcess, SidecarSpec,
    };
    use crate::plugin_manifest::ProvidesEntry;
    crate::plugin_manifest::PluginManifest {
        id: "@ryu/rag".to_owned(),
        name: "RAG".to_owned(),
        version: "1.0.0".to_owned(),
        sidecars: vec![SidecarSpec {
            name: "rag".to_owned(),
            process: SidecarProcess::Binary(BinarySpec {
                url: "https://example.com/rag".to_owned(),
                version: "1.0.0".to_owned(),
                sha256: None,
                archive: None,
                binary_name: None,
                args: vec![],
                env: Default::default(),
            }),
            port,
            health_path: "/health".to_owned(),
            http: Some(HttpProxySpec {
                mount: mount.map(str::to_owned),
                public_mount: None,
                forward_cookie_names: Vec::new(),
                forward_caller_email: false,
                caller_resource_scope: None,
                forward_caller_rate_subject: false,
                routes: vec![RouteSpec {
                    path: "/query".to_owned(),
                    method: None,
                    auth: Default::default(),
                    permission: None,
                    resource_param: None,
                }],
                max_body_bytes: None,
            }),
            host_api: None,
            lazy: false,
            idle_stop_secs: None,
            provides_provider: None,
            sandbox: None,
        }],
        provides: vec![ProvidesEntry {
            capability: "rag".to_owned(),
            version: "1.0.0".to_owned(),
            sidecar: Some("rag".to_owned()),
            route: Some("/query".to_owned()),
            grant: Some("cap:rag".to_owned()),
            ..Default::default()
        }],
        ..Default::default()
    }
}

/// A manifest fixture for the web-delegation gate: an optional `surfaces.web`
/// level, an optional Companion runnable, declared grants, and one annotated
/// (`/items`) and one unannotated (`/open`) route. Routes are `public` so these
/// tests never depend on whichever node token the test process holds.
fn web_app(
    id: &str,
    web: Option<&str>,
    companion: bool,
    grants: &[&str],
) -> crate::plugin_manifest::PluginManifest {
    let runnables = if companion {
        json!([{ "id": "panel", "name": "Panel", "kind": "companion",
                 "config": { "label": "Panel" } }])
    } else {
        json!([])
    };
    let mut value = json!({
        "id": id, "name": id, "version": "1.0.0",
        "runnables": runnables,
        "permission_grants": grants,
        "sidecars": [{ "name": "svc", "port": 18997,
                       "process": { "kind": "local", "command": "true" },
                       "http": { "mount": "/api/svc", "routes": [
                           { "path": "/items", "permission": "items.view", "auth": "public" },
                           { "path": "/open", "auth": "public" }
                       ] } }],
    });
    if let Some(level) = web {
        value["surfaces"] = json!({ "web": { "support": level } });
    }
    serde_json::from_value(value).expect("web app fixture parses")
}

fn org_bound_node(org: &str) -> crate::sidecar::control_plane::RegisteredNode {
    crate::sidecar::control_plane::RegisteredNode {
        org: crate::sidecar::control_plane::RegisteredOrg {
            id: org.to_owned(),
            name: org.to_owned(),
            slug: None,
        },
        node_id: "node-web".to_owned(),
        scope: crate::sidecar::control_plane::NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}
