//! Secret references for the managed Pi's own config files.
//!
//! Pi reads `auth.json` and `models.json` from `PI_CODING_AGENT_DIR` itself, so
//! anything Ryu writes there is plaintext on disk. For values Pi resolves through
//! its config-value templates, Ryu writes a `${RYU_PI_…}` reference instead of
//! the secret and hands the real value to the Pi process in its environment at
//! spawn. Verified against the managed engine
//! (`@earendil-works/pi-coding-agent`, `dist/core/resolve-config-value.js` and
//! `dist/core/auth-storage.js`): `$VAR` / `${VAR}` templates are resolved from the
//! process environment for a `models.json` provider `apiKey` and `headers`
//! value, and for an `auth.json` `{"type":"api_key","key":…}` entry.
//!
//! What this covers:
//!
//! - API keys of built-in providers (`auth.json`) and custom providers
//!   (`models.json` `apiKey`): the sealed account vault (`pi-accounts.db`) holds
//!   the key; the file holds `${RYU_PI_KEY_<hex scope key>}`.
//! - The node bearer Core's loopback provider routes check (`x-ryu-node-token`).
//! - The managed fleet bearer (`${RYU_PI_FLEET_TOKEN}`).
//! - A plugin sidecar provider's minted ext token (`${RYU_PI_EXT_<hex id>}`),
//!   kept only in Core's memory.
//!
//! What it does not cover: OAuth subscription logins Pi refreshes itself
//! (`{"type":"oauth",…}` entries take no template, and Pi writes rotated tokens
//! back to `auth.json`). Those stay plaintext `0600` in the `0700` config dir.
//!
//! The values live in the Pi process environment, so Pi and every process it
//! starts (its shell tool, sub-agents, language servers) inherit them, exactly
//! like the per-agent Gateway bearer already passed as `OPENAI_API_KEY`.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::accounts;

/// The node bearer for Core's loopback provider routes.
pub(crate) const NODE_TOKEN_ENV: &str = "RYU_PI_NODE_TOKEN";
/// The managed fleet bearer (hosted gateway) for the managed provider.
pub(crate) const FLEET_TOKEN_ENV: &str = "RYU_PI_FLEET_TOKEN";
/// The API key of a captured per-conversation account
/// (`account-sessions/<key>/auth.json`).
pub(crate) const SESSION_KEY_ENV: &str = "RYU_PI_SESSION_KEY";
/// Prefix of a provider API-key reference; the rest is the upper-case hex of
/// the vault scope key (an `auth.json` key or a custom provider id), so two ids
/// can never map to the same variable.
const PROVIDER_KEY_PREFIX: &str = "RYU_PI_KEY_";
/// Prefix of a plugin sidecar provider's ext-token reference.
const EXT_TOKEN_PREFIX: &str = "RYU_PI_EXT_";
/// Every variable this module defines starts with this.
const RESERVED_PREFIX: &str = "RYU_PI_";

/// Plugin sidecar provider id → its minted ext token. In memory only: the token
/// is minted per sidecar process and re-registered on its next healthy edge.
static EXT_TOKENS: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

/// The variable carrying the API key of vault scope key `scope_key`.
pub(crate) fn provider_key_env(scope_key: &str) -> String {
    format!("{PROVIDER_KEY_PREFIX}{}", hex::encode_upper(scope_key))
}

/// The variable carrying plugin provider `provider_id`'s ext token.
pub(crate) fn ext_token_env(provider_id: &str) -> String {
    format!("{EXT_TOKEN_PREFIX}{}", hex::encode_upper(provider_id))
}

/// The `${NAME}` template Pi resolves from its environment.
pub(crate) fn reference(name: &str) -> String {
    format!("${{{name}}}")
}

/// The variable a stored value refers to, when it is exactly one of this
/// module's `${RYU_PI_…}` references.
pub(crate) fn referenced_env(value: &str) -> Option<&str> {
    let name = value.strip_prefix("${")?.strip_suffix('}')?;
    (name.starts_with(RESERVED_PREFIX)
        && name.len() > RESERVED_PREFIX.len()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'))
    .then_some(name)
}

/// Whether a stored value is a reference rather than a secret.
pub(crate) fn is_reference(value: &str) -> bool {
    referenced_env(value).is_some()
}

/// Whether `name` is a variable [`secret_env`] (or a session account) sets.
pub(crate) fn is_secret_env_name(name: &str) -> bool {
    [NODE_TOKEN_ENV, FLEET_TOKEN_ENV, SESSION_KEY_ENV].contains(&name)
        || name.starts_with(PROVIDER_KEY_PREFIX)
        || name.starts_with(EXT_TOKEN_PREFIX)
}

/// Remember a plugin provider's ext token so Pi spawns receive it.
pub(crate) fn remember_ext_token(provider_id: &str, token: &str) {
    if let Ok(mut tokens) = EXT_TOKENS.lock() {
        tokens.insert(provider_id.to_owned(), token.to_owned());
    }
}

/// Forget a plugin provider's ext token (its provider entry was removed).
pub(crate) fn forget_ext_token(provider_id: &str) {
    if let Ok(mut tokens) = EXT_TOKENS.lock() {
        tokens.remove(provider_id);
    }
}

/// Vault scopes whose credential Pi never reads from its own files: they are
/// served by a Core proxy (ChatGPT plan, Kiro) or a native CLI (Qoder).
fn proxied_scope_key(scope_key: &str) -> bool {
    scope_key == super::CHATGPT_PLAN_AUTH_KEY
        || scope_key == super::KIRO_PROVIDER_ID
        || super::qoder_cli::is_provider(scope_key)
}

/// Non-secret `apiKey` values Ryu itself writes for providers Core proxies.
const PROXY_SENTINELS: &[&str] = &["ryu-local-proxy", "ryu-chatgpt-plan-proxy", "ryu-local"];

/// Whether a stored key is not a secret Ryu should move out of the file: a Pi
/// template (`$VAR`, `${VAR}`, including this module's references), a Pi
/// `!command`, or one of Ryu's proxy sentinels.
pub(crate) fn is_non_secret_key(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.is_empty()
        || trimmed.contains('$')
        || trimmed.starts_with('!')
        || PROXY_SENTINELS.contains(&trimmed)
        || trimmed == super::CHATGPT_PROXY_API_KEY
}

/// The API key inside a vault credential: a bare string (custom provider) or
/// `{"type":"api_key","key":…}` (built-in provider). `None` for OAuth and for a
/// value that is not a secret ([`is_non_secret_key`]), so a template or sentinel
/// is left in the file exactly as it was.
pub(crate) fn api_key_of(credential: &Value) -> Option<&str> {
    let key = credential.as_str().or_else(|| {
        (credential.get("type").and_then(Value::as_str) != Some("oauth"))
            .then(|| credential.get("key").and_then(Value::as_str))
            .flatten()
    })?;
    (!is_non_secret_key(key)).then_some(key)
}

/// The provider API keys of every active vault account, by variable name.
fn vault_api_keys(vault: &accounts::AccountVault, env: &mut BTreeMap<String, String>) {
    let Ok(scopes) = vault.scopes() else {
        return;
    };
    for scope in scopes {
        if !accounts::is_provider_scope(&scope) {
            continue;
        }
        let scope_key = accounts::scope_key(&scope);
        if proxied_scope_key(scope_key) {
            continue;
        }
        match vault.active_credential(&scope) {
            Ok(Some((_, credential))) => {
                if let Some(key) = api_key_of(&credential) {
                    env.insert(provider_key_env(scope_key), key.to_owned());
                }
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(scope, %error, "Pi secret env: could not open an active account");
            }
        }
    }
}

/// The secret environment for a managed Pi spawn, sorted by name.
pub(crate) fn secret_env() -> Vec<(String, String)> {
    let mut env = BTreeMap::new();
    // `ryu-local` is the placeholder these headers always carried when the node
    // has no bearer yet; Pi refuses a provider whose header template is unset.
    env.insert(
        NODE_TOKEN_ENV.to_owned(),
        crate::node_token::active_token().unwrap_or_else(|| "ryu-local".to_owned()),
    );
    if let Some((_, token)) = crate::sidecar::gateway::managed_fleet() {
        if !token.trim().is_empty() {
            env.insert(FLEET_TOKEN_ENV.to_owned(), token);
        }
    }
    if let Ok(tokens) = EXT_TOKENS.lock() {
        for (provider_id, token) in tokens.iter() {
            env.insert(ext_token_env(provider_id), token.clone());
        }
    }
    if let Some(vault) = accounts::global() {
        vault_api_keys(vault, &mut env);
    }
    env.into_iter().collect()
}

/// A digest of [`secret_env`], for the ACP pool key: when a key is added,
/// rotated or switched, the next turn spawns a Pi that carries the new value
/// instead of reusing a process whose environment is stale. Never the values.
pub(crate) fn fingerprint() -> String {
    fingerprint_of(&secret_env())
}

fn fingerprint_of(env: &[(String, String)]) -> String {
    let mut hasher = Sha256::new();
    for (name, value) in env {
        hasher.update(name.as_bytes());
        hasher.update([0]);
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    hex::encode(&hasher.finalize()[..12])
}

/// The value a stored `auth.json` key / `models.json` `apiKey` stands for:
/// a reference is resolved the way Pi will resolve it at spawn; a literal (a
/// legacy plaintext value, or a non-secret sentinel) is returned as is.
pub(crate) fn resolve(stored: &str) -> Option<String> {
    let Some(name) = referenced_env(stored) else {
        return Some(stored.to_owned());
    };
    secret_env()
        .into_iter()
        .find_map(|(candidate, value)| (candidate == name).then_some(value))
}

/// Replace every literal `x-ryu-node-token` header in `models` with the env
/// reference. Returns whether anything changed.
pub(crate) fn template_node_token_headers(models: &mut Value) -> bool {
    let Some(providers) = models.get_mut("providers").and_then(Value::as_object_mut) else {
        return false;
    };
    let mut changed = false;
    for provider in providers.values_mut() {
        let Some(headers) = provider.get_mut("headers").and_then(Value::as_object_mut) else {
            continue;
        };
        if let Some(value) = headers.get_mut("x-ryu-node-token") {
            if value.as_str().is_some_and(|stored| !is_reference(stored)) {
                *value = Value::String(reference(NODE_TOKEN_ENV));
                changed = true;
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn references_are_recognised_only_in_the_reserved_namespace() {
        assert_eq!(
            referenced_env("${RYU_PI_NODE_TOKEN}"),
            Some("RYU_PI_NODE_TOKEN")
        );
        let key_env = provider_key_env("anthropic");
        assert_eq!(key_env, "RYU_PI_KEY_616E7468726F706963");
        assert!(is_reference(&reference(&key_env)));
        for literal in [
            "${OPENAI_API_KEY}",
            "$RYU_PI_NODE_TOKEN",
            "${RYU_PI_}",
            "${RYU_PI_key}",
            "sk-live-123",
            "",
        ] {
            assert!(!is_reference(literal), "{literal} must be a literal");
        }
    }

    #[test]
    fn secret_env_names_are_recognised_and_other_pi_variables_are_not() {
        for name in [
            NODE_TOKEN_ENV.to_owned(),
            FLEET_TOKEN_ENV.to_owned(),
            SESSION_KEY_ENV.to_owned(),
            provider_key_env("openai"),
            ext_token_env("@ryu/fixture"),
        ] {
            assert!(is_secret_env_name(&name), "{name}");
        }
        for name in [
            "RYU_PI_AGENT_DIR",
            "RYU_PI_HOST_CONVERSATION_ID",
            "RYU_PI_ACCOUNT_CAPTURE",
            "PI_CODING_AGENT_DIR",
        ] {
            assert!(!is_secret_env_name(name), "{name}");
        }
    }

    #[test]
    fn distinct_ids_never_share_a_variable() {
        assert_ne!(provider_key_env("a-b"), provider_key_env("a_b"));
        assert_ne!(ext_token_env("A"), ext_token_env("a"));
    }

    #[test]
    fn api_key_of_reads_both_shapes_and_skips_oauth_and_references() {
        assert_eq!(api_key_of(&json!("sk-custom")), Some("sk-custom"));
        assert_eq!(
            api_key_of(&json!({"type": "api_key", "key": "sk-builtin"})),
            Some("sk-builtin")
        );
        assert_eq!(
            api_key_of(&json!({"type": "oauth", "access": "a", "refresh": "r", "key": "x"})),
            None
        );
        for not_secret in [
            "${RYU_PI_KEY_41}",
            "${OPENAI_API_KEY}",
            "!op read op://vault/key",
            "ryu-local-proxy",
            "  ",
        ] {
            assert_eq!(api_key_of(&json!(not_secret)), None, "{not_secret}");
        }
    }

    #[test]
    fn vault_keys_become_env_and_proxied_scopes_are_skipped() {
        let vault = accounts::AccountVault::in_memory().unwrap();
        vault
            .upsert(
                &accounts::provider_scope("anthropic"),
                "acct_a",
                "API key",
                accounts::KIND_API_KEY,
                Some(json!({"type": "api_key", "key": "sk-ant-fixture"})),
            )
            .unwrap();
        vault
            .upsert(
                &accounts::provider_scope("my-vllm"),
                "acct_b",
                "API key",
                accounts::KIND_API_KEY,
                Some(json!("vllm-fixture")),
            )
            .unwrap();
        vault
            .upsert(
                &accounts::provider_scope("github-copilot"),
                "acct_c",
                "Login",
                accounts::KIND_OAUTH,
                Some(json!({"type": "oauth", "access": "gho", "refresh": "r", "expires": 1})),
            )
            .unwrap();
        vault
            .upsert(
                &accounts::provider_scope(super::super::KIRO_PROVIDER_ID),
                "acct_d",
                "Login",
                accounts::KIND_API_KEY,
                Some(json!("kiro-not-for-pi")),
            )
            .unwrap();
        let mut env = BTreeMap::new();
        vault_api_keys(&vault, &mut env);
        assert_eq!(
            env.get(&provider_key_env("anthropic")).map(String::as_str),
            Some("sk-ant-fixture")
        );
        assert_eq!(
            env.get(&provider_key_env("my-vllm")).map(String::as_str),
            Some("vllm-fixture")
        );
        assert_eq!(
            env.len(),
            2,
            "OAuth and proxied scopes stay out: {:?}",
            env.keys()
        );
    }

    #[test]
    fn fingerprint_changes_with_values_and_never_contains_them() {
        let first = vec![("RYU_PI_KEY_41".to_owned(), "sk-one".to_owned())];
        let second = vec![("RYU_PI_KEY_41".to_owned(), "sk-two".to_owned())];
        assert_ne!(fingerprint_of(&first), fingerprint_of(&second));
        assert_eq!(fingerprint_of(&first), fingerprint_of(&first));
        assert!(!fingerprint_of(&first).contains("sk-one"));
    }

    #[test]
    fn node_token_headers_are_templated_once() {
        let mut models = json!({"providers": {
            "kiro": {"headers": {"x-ryu-node-token": "node-secret", "x-ryu-session-id": "$RYU_PI_HOST_CONVERSATION_ID"}},
            "openai": {"apiKey": "${OPENAI_API_KEY}"}
        }});
        assert!(template_node_token_headers(&mut models));
        assert_eq!(
            models["providers"]["kiro"]["headers"]["x-ryu-node-token"],
            "${RYU_PI_NODE_TOKEN}"
        );
        assert_eq!(
            models["providers"]["kiro"]["headers"]["x-ryu-session-id"],
            "$RYU_PI_HOST_CONVERSATION_ID"
        );
        assert!(!template_node_token_headers(&mut models));
        assert!(!models.to_string().contains("node-secret"));
    }

    #[test]
    fn resolve_passes_literals_through() {
        assert_eq!(
            resolve("ryu-local-proxy").as_deref(),
            Some("ryu-local-proxy")
        );
        assert_eq!(resolve("${RYU_PI_EXT_00}"), None);
        remember_ext_token("fixture-provider-resolve", "ext-fixture");
        assert_eq!(
            resolve(&reference(&ext_token_env("fixture-provider-resolve"))).as_deref(),
            Some("ext-fixture")
        );
        forget_ext_token("fixture-provider-resolve");
        assert_eq!(
            resolve(&reference(&ext_token_env("fixture-provider-resolve"))),
            None
        );
    }
}
