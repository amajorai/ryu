//! Detecting user secret references in MCP server configs.

use super::*;

pub(super) fn has_vault_secret_reference(value: &str) -> bool {
    value
        .split_whitespace()
        .any(|word| word.strip_prefix("secret:").is_some())
}

/// Whether a header or env value, or an app tool's secret source, names one
/// of the user's saved keys: a `secret:`, `vault:` or `env:` reference.
/// `env:RYU_TOKEN` is Core's own signed agent lane, never a user key.
pub(super) fn source_references_user_secret(value: &str) -> bool {
    value.split_whitespace().any(|word| {
        word.starts_with("secret:")
            || word.starts_with("vault:")
            || (word.starts_with("env:") && word != "env:RYU_TOKEN")
    })
}

/// Whether calling `cfg` hands it one of the user's saved keys: a credential
/// reference in its headers or env, or, for a server the user added, a key
/// typed straight into its config ([`user_added_config_may_carry_key`]).
/// Checked on the stored config, before
/// [`McpRegistry::resolve_mcp_secret_config`] replaces the references.
pub(super) fn config_references_user_secret(cfg: &McpServerConfig) -> bool {
    cfg.headers
        .values()
        .chain(cfg.env.values())
        .any(|value| source_references_user_secret(value))
        || (cfg.owner_plugin_id.is_none() && user_added_config_may_carry_key(cfg))
}

/// Whether a server the user added may carry a key they typed into it. A key
/// can sit anywhere in such a config, under any name, so this fails closed:
/// any header or env value counts, and so does a URL with sign-in details, a
/// query, a fragment or an opaque path segment (`/mcp/<key>/sse`), and an
/// argument that names a key (`--api-key …`) or looks like one. A server that
/// merely looks keyed then needs its `mcp-secret:` entry; one that is keyed is
/// never missed for being named unusually.
fn user_added_config_may_carry_key(cfg: &McpServerConfig) -> bool {
    auth_metadata(cfg).1
        || cfg
            .headers
            .values()
            .chain(cfg.env.values())
            .any(|value| !value.trim().is_empty())
        || cfg.url.as_deref().is_some_and(url_may_carry_key)
        || cfg.args.iter().any(|arg| arg_may_carry_key(arg))
}

/// See [`user_added_config_may_carry_key`]. A URL that does not parse counts.
fn url_may_carry_key(raw: &str) -> bool {
    let raw = raw.trim();
    if raw.is_empty() {
        return false;
    }
    let Ok(url) = url::Url::parse(raw) else {
        return true;
    };
    !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url
            .path_segments()
            .is_some_and(|mut segments| segments.any(looks_like_opaque_key))
}

/// See [`user_added_config_may_carry_key`]: a flag or `NAME=value` pair whose
/// name says it holds a key, or a value that looks like one.
fn arg_may_carry_key(arg: &str) -> bool {
    let arg = arg.trim();
    let (name, value) = arg.split_once('=').unwrap_or((arg, ""));
    let name = name.trim_start_matches('-');
    let names_a_key = name
        .split(['-', '_', '.'])
        .map(str::to_ascii_lowercase)
        .any(|part| {
            matches!(
                part.as_str(),
                "key"
                    | "apikey"
                    | "token"
                    | "secret"
                    | "password"
                    | "passwd"
                    | "pat"
                    | "auth"
                    | "bearer"
                    | "credential"
                    | "credentials"
            )
        });
    names_a_key
        || looks_like_opaque_key(arg)
        || (!value.is_empty() && looks_like_opaque_key(value))
        || url::Url::parse(arg).is_ok_and(|_| url_may_carry_key(arg))
}

/// A run of at least 16 key-like characters (letters, digits, `-`, `_`, `.`,
/// `~`, `+`, `=`) with both letters and digits, the shape of an API key or a
/// key-bearing URL segment. Paths, package names and plain words don't match.
fn looks_like_opaque_key(value: &str) -> bool {
    let value = value.trim();
    value.len() >= 16
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '+' | '='))
        && value.chars().any(|c| c.is_ascii_digit())
        && value.chars().any(|c| c.is_ascii_alphabetic())
}

/// The `mcp-secret:<id>` id for a server's saved keys: its owning plugin, so
/// one entry covers a plugin's MCP servers and app tools, or the server name
/// for a server the user added.
pub(super) fn saved_key_account_id<'a>(server: &'a str, cfg: &'a McpServerConfig) -> &'a str {
    cfg.owner_plugin_id.as_deref().unwrap_or(server)
}

pub(super) async fn resolve_mcp_secret_map(
    store: &crate::plugin_secrets::PluginSecretStore,
    values: &BTreeMap<String, String>,
    context: &crate::plugin_secrets::SecretResolutionContext,
) -> Result<BTreeMap<String, String>> {
    let mut resolved = BTreeMap::new();
    for (key, value) in values {
        if !has_vault_secret_reference(value) {
            resolved.insert(key.clone(), value.clone());
            continue;
        }
        // An unavailable or unauthorized reference is omitted. Passing the
        // literal `secret:NAME` to an upstream MCP server would turn a missing
        // authorization into a credential-looking string and is never safe.
        if let Some(value) = store.resolve_vault_template(value, context).await? {
            resolved.insert(key.clone(), value);
        }
    }
    Ok(resolved)
}

#[cfg(test)]
mod vault_reference_tests {
    use super::{resolve_mcp_secret_map, McpServerConfig};
    use crate::plugin_secrets::{PluginSecretStore, SecretResolutionContext, SecretScope};
    use std::collections::BTreeMap;

    #[tokio::test]
    async fn mcp_secret_references_resolve_server_side_and_missing_values_drop() {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .set_vault_secret(
                SecretScope::Node,
                "node-1",
                None,
                "GITHUB_TOKEN",
                "ghs-server-side",
            )
            .await
            .unwrap();
        let context = SecretResolutionContext::node_only("node-1", vec!["github".to_owned()]);
        let values = BTreeMap::from([
            (
                "Authorization".to_owned(),
                "Bearer secret:GITHUB_TOKEN".to_owned(),
            ),
            ("X-Missing".to_owned(), "secret:NO_SUCH_TOKEN".to_owned()),
            ("X-Static".to_owned(), "static".to_owned()),
        ]);
        let resolved = resolve_mcp_secret_map(&store, &values, &context)
            .await
            .unwrap();
        assert_eq!(
            resolved.get("Authorization").map(String::as_str),
            Some("Bearer ghs-server-side")
        );
        assert!(!resolved.contains_key("X-Missing"));
        assert_eq!(resolved.get("X-Static").map(String::as_str), Some("static"));

        // A config clone is the only carrier into client::connect; no value is
        // written back to the original MCP configuration.
        let original = McpServerConfig {
            headers: values,
            ..McpServerConfig::default()
        };
        assert_eq!(
            original.headers.get("Authorization").map(String::as_str),
            Some("Bearer secret:GITHUB_TOKEN")
        );
    }
}

#[cfg(test)]
#[path = "tests/secret_refs.rs"]
mod tests;
