//! The host callback a manifest-owned stdio MCP server receives at spawn.
//!
//! An app can ship the same binary twice: as an HTTP sidecar and as a stdio MCP
//! server (`mcp_servers.<name>` with `args: ["mcp"]`). The sidecar spawn has always
//! injected the per-plugin host contract (`RYU_EXT_TOKEN`, `RYU_EXT_PLUGIN_ID`,
//! `RYU_CORE_PORT`), so its model-backed routes reach `POST /api/host/model/complete`.
//! The MCP spawn did not: `client::spawn_stdio` clears the environment and passes
//! only `mcp_safe_env` plus the declared `env`, so a tool that needs the model (a
//! prose check that must be translated into logic before a solver can decide it)
//! always failed with "no model callback", and every caller saw a non-answer.
//!
//! The env is layered here, at call time, onto the config [`super::McpRegistry`]
//! hands to `to_target()`, never onto the stored registration: the stored config is
//! what `GET /api/mcp/servers` summarizes (its `env_keys`), and a minted credential
//! must not be listed or persisted. Nothing is added to `MCP_SAFE_ALLOWLIST`, since
//! that allowlist forwards Core's own inherited env, and this is a value Core mints
//! for exactly this child.
//!
//! **Gate: the owner already declares a host-API grant ceiling.** Core authorizes a
//! host callback by the per-plugin token against the union of the owning manifest's
//! sidecar `host_api.grants`, intersected with the Gateway-approved grants
//! (`ext_proxy::authorize_host_call`). That ceiling is per plugin, not per process,
//! so handing the token to the plugin's own MCP child grants nothing its sidecar does
//! not already hold. A plugin that declares no `host_api` gets nothing here, which
//! keeps every other manifest-owned server's spawn env unchanged.

use std::collections::BTreeMap;

use crate::plugin_manifest::PluginManifest;

use super::{McpServerConfig, McpTransportKind};

/// Whether `manifest` declares any host-API grant on any of its sidecars: the
/// ceiling `ext_proxy::authorize_host_call` checks a host callback against.
fn declares_host_api(manifest: &PluginManifest) -> bool {
    manifest
        .sidecars
        .iter()
        .filter_map(|sidecar| sidecar.host_api.as_ref())
        .any(|host_api| !host_api.grants.is_empty())
}

/// The owning plugin id when `config` should receive the host callback env: a
/// stdio server registered from a manifest (`owner_plugin_id`) whose owner declares
/// a host-API ceiling. Remote servers have no process env, and catalog installs
/// carry no owner on the wire, so both return `None`.
fn host_env_owner<'a>(
    config: &'a McpServerConfig,
    manifests: &[PluginManifest],
) -> Option<&'a str> {
    let owner = config.owner_plugin_id.as_deref()?;
    if config.transport_kind() != McpTransportKind::Stdio {
        return None;
    }
    manifests
        .iter()
        .find(|manifest| manifest.id == owner)
        .filter(|manifest| declares_host_api(manifest))
        .map(|_| owner)
}

/// Write the three reserved host-contract keys. Applied last, over the declared
/// env, so a manifest cannot point its own child at another plugin's identity or a
/// different port (the same rule the sidecar spawn applies).
fn insert_host_env(
    env: &mut BTreeMap<String, String>,
    plugin_id: &str,
    token: String,
    core_port: String,
) {
    env.insert(crate::sidecar::ext_proxy::ENV_EXT_TOKEN.to_owned(), token);
    env.insert(
        crate::sidecar::ext_proxy::ENV_EXT_PLUGIN_ID.to_owned(),
        plugin_id.to_owned(),
    );
    env.insert(
        crate::sidecar::cli_shims::ENV_CORE_PORT.to_owned(),
        core_port,
    );
}

/// Layer the owner's host callback env onto `config` when [`host_env_owner`]
/// admits it. The token is read per call, like the sidecar health probe does, so a
/// rotated plugin credential reaches the next spawn.
pub(super) fn apply(config: &mut McpServerConfig, manifests: &[PluginManifest]) {
    let Some(owner) = host_env_owner(config, manifests).map(str::to_owned) else {
        return;
    };
    let token = crate::sidecar::ext_proxy::ext_token(
        crate::sidecar::ext_proxy::node_token().as_deref(),
        &owner,
    );
    insert_host_env(
        &mut config.env,
        &owner,
        token,
        crate::sidecar::cli_shims::core_port_string(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "com.example.hosted";

    /// A manifest whose one sidecar declares `grants` as its host-API ceiling.
    fn hosted(grants: Option<&[&str]>) -> PluginManifest {
        let mut sidecar = serde_json::json!({
            "name": "engine",
            "process": {"kind": "local", "command": "hosted-engine"},
            "port": 9100
        });
        if let Some(grants) = grants {
            sidecar["host_api"] = serde_json::json!({ "grants": grants });
        }
        PluginManifest {
            id: OWNER.to_owned(),
            sidecars: vec![serde_json::from_value(sidecar).expect("sidecar spec")],
            ..PluginManifest::default()
        }
    }

    fn owned_stdio(owner: &str) -> McpServerConfig {
        McpServerConfig {
            command: Some("hosted-engine".to_owned()),
            args: vec!["mcp".to_owned()],
            owner_plugin_id: Some(owner.to_owned()),
            owner_server_name: Some("engine".to_owned()),
            ..McpServerConfig::default()
        }
    }

    #[test]
    fn a_host_api_owner_admits_its_own_stdio_server() {
        let manifest = hosted(Some(&["hook:side-model"]));
        assert!(declares_host_api(&manifest));
        assert_eq!(
            host_env_owner(&owned_stdio(OWNER), std::slice::from_ref(&manifest)),
            Some(OWNER)
        );
    }

    #[test]
    fn no_owner_no_ceiling_or_a_remote_transport_admits_nothing() {
        let manifest = hosted(Some(&["hook:side-model"]));
        let manifests = std::slice::from_ref(&manifest);

        let mut unowned = owned_stdio(OWNER);
        unowned.owner_plugin_id = None;
        assert_eq!(host_env_owner(&unowned, manifests), None);

        let mut remote = owned_stdio(OWNER);
        remote.command = None;
        remote.url = Some("http://127.0.0.1:1/mcp".to_owned());
        assert_eq!(host_env_owner(&remote, manifests), None);

        for ceiling in [None, Some(&[][..])] {
            let manifest = hosted(ceiling);
            assert!(!declares_host_api(&manifest));
            assert_eq!(
                host_env_owner(&owned_stdio(OWNER), std::slice::from_ref(&manifest)),
                None
            );
        }

        assert_eq!(
            host_env_owner(&owned_stdio("com.example.absent"), manifests),
            None
        );
    }

    #[test]
    fn reserved_keys_override_the_declared_env_and_keep_the_rest() {
        let mut env = BTreeMap::from([
            ("RYU_EXT_TOKEN".to_owned(), "declared".to_owned()),
            (
                "RYU_EXT_PLUGIN_ID".to_owned(),
                "com.example.other".to_owned(),
            ),
            ("RYU_CORE_PORT".to_owned(), "1".to_owned()),
            ("KEEP".to_owned(), "yes".to_owned()),
        ]);
        insert_host_env(&mut env, OWNER, "minted".to_owned(), "7980".to_owned());
        assert_eq!(env["RYU_EXT_TOKEN"], "minted");
        assert_eq!(env["RYU_EXT_PLUGIN_ID"], OWNER);
        assert_eq!(env["RYU_CORE_PORT"], "7980");
        assert_eq!(env["KEEP"], "yes");
    }
}
