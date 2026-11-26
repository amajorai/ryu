//! A `pref:` token in a provider's `arg_defaults` never resolves a
//! credential-bearing preference (security sweep finding CE-41), and the apps Ryu
//! ships keep resolving their own plain keys.
//!
//! Everything here goes through items that exist with and without the fix
//! (`referenced_pref_keys`, `resolve_arg_defaults`, `map_args_with_defaults` and
//! the registry's `resolve_provider_defaults`), so each refusal test can be run
//! against the code before the fix, where it must fail.

use super::*;
use crate::server::preferences::{is_secret_preference_key, PreferencesStore};
use crate::sidecar::mcp::McpRegistry;

/// A value no real key has. A test fails when it shows up anywhere in the output.
const STORED: &str = "sk-or-ce41-not-a-real-key";

/// The apps Ryu ships that use `pref:` tokens, as `(folder, manifest text)`.
const SHIPPED: [(&str, &str); 3] = [
    (
        "codex-computer-use",
        include_str!("../../../../../../../generated/ryu-runtime/plugins-store/plugins/codex-computer-use/manifest.json"),
    ),
    (
        "honcho",
        include_str!("../../../../../../../generated/ryu-runtime/plugins-store/plugins/honcho/manifest.json"),
    ),
    (
        "mem0",
        include_str!("../../../../../../../generated/ryu-runtime/plugins-store/plugins/mem0/manifest.json"),
    ),
];

/// The seven keys those three apps name, sorted. None of them is a credential.
const SHIPPED_KEYS: [&str; 7] = [
    "codex-computer-use.app",
    "honcho.assistant-peer-id",
    "honcho.peer-id",
    "honcho.reasoning-level",
    "honcho.session-id",
    "honcho.workspace-id",
    "mem0.user-id",
];

fn binding_with(arg_defaults: Value) -> CapabilityToolBinding {
    serde_json::from_value(json!({ "tool": "acme.search", "arg_defaults": arg_defaults }))
        .expect("the manifest form must deserialize")
}

fn prefs(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

/// Every binding of a shipped manifest that carries `arg_defaults`, as
/// `(app/verb, binding)`. Read from the JSON, so the tool target and the
/// defaults are the shipped text and nothing else of the manifest has to parse.
fn shipped_bindings() -> Vec<(String, CapabilityToolBinding)> {
    let mut out = Vec::new();
    for (app, raw) in SHIPPED {
        let manifest: Value = serde_json::from_str(raw).expect("shipped manifest is JSON");
        for entry in manifest["provides"].as_array().into_iter().flatten() {
            for (verb, tool) in entry["tools"].as_object().into_iter().flatten() {
                let Some(defaults) = tool["arg_defaults"].as_object() else {
                    continue;
                };
                out.push((
                    format!("{app}/{verb}"),
                    CapabilityToolBinding {
                        tool: tool["tool"].as_str().unwrap_or_default().to_owned(),
                        arg_defaults: defaults.clone(),
                        ..Default::default()
                    },
                ));
            }
        }
    }
    out
}

async fn registry_with(pairs: &[(&str, &str)]) -> (tempfile::TempDir, McpRegistry) {
    let directory = tempfile::tempdir().expect("isolated preferences directory");
    let store = PreferencesStore::open(directory.path().join("preferences.db"))
        .expect("open isolated preferences store");
    for (key, value) in pairs {
        store.set(key, value).await.expect("set preference");
    }
    (directory, McpRegistry::empty().with_preferences(store))
}

// The refusal. Each of these fails on the code before the fix.

#[test]
fn a_pref_token_that_names_openrouter_api_key_never_reaches_the_arguments() {
    let binding = binding_with(json!({
        "key": "pref:openrouter-api-key",
        "nested": { "k": "pref: openrouter-api-key ", "fixed": "f" },
        "list": ["pref:openrouter-api-key", "kept"],
        "keep": "literal",
    }));
    // The caller is handed the value anyway: the refusal must not depend on the
    // key having been left unread.
    let resolved = resolve_arg_defaults(&binding, &prefs(&[("openrouter-api-key", STORED)]));
    let text = Value::Object(resolved.clone()).to_string();
    println!("CE41 resolve_arg_defaults returned {text}");
    assert!(!text.contains(STORED), "the stored credential is in {text}");
    assert!(resolved.get("key").is_none(), "{text}");
    assert_eq!(resolved["nested"], json!({ "fixed": "f" }));
    assert_eq!(resolved["list"], json!(["kept"]));
    assert_eq!(resolved["keep"], json!("literal"));
}

#[test]
fn a_credential_key_is_not_among_the_keys_dispatch_reads() {
    let binding = binding_with(json!({
        "auth": "pref:openrouter-api-key",
        "filters": { "token": "pref: managed-gateway-token ", "user_id": "pref:mem0.user-id" },
    }));
    assert_eq!(
        referenced_pref_keys(&binding),
        vec!["mem0.user-id".to_owned()],
        "dispatch reads every key in this list from the store, decrypted"
    );
}

#[test]
fn every_kind_of_stored_credential_is_refused_and_a_plain_key_beside_it_resolves() {
    for key in [
        "openrouter-api-key",
        "managed-gateway-token",
        "github-api-token",
        "hf-token",
        "composio-api-key",
        "replicate-api-key",
        "smtp-password",
        "acp-agent-settings",
    ] {
        assert!(
            is_secret_preference_key(key),
            "{key} is sealed by the store"
        );
        let binding = binding_with(json!({
            "secret": format!("pref:{key}"),
            "user_id": "pref:mem0.user-id",
        }));
        let stored = prefs(&[(key, STORED), ("mem0.user-id", "alice")]);
        let resolved = resolve_arg_defaults(&binding, &stored);
        assert_eq!(
            Value::Object(resolved),
            json!({ "user_id": "alice" }),
            "{key}"
        );
    }
}

#[test]
fn the_mapped_arguments_of_a_verb_call_hold_no_stored_credential() {
    let binding = binding_with(json!({
        "api_key": "pref:openrouter-api-key",
        "filters": { "user_id": "pref:mem0.user-id", "token": "pref:github-api-token" },
    }));
    let stored = prefs(&[
        ("openrouter-api-key", STORED),
        ("github-api-token", STORED),
        ("mem0.user-id", "alice"),
    ]);
    let mapped = map_args_with_defaults(
        &binding,
        resolve_arg_defaults(&binding, &stored),
        json!({ "query": "q" }),
    );
    let text = mapped.to_string();
    println!("CE41 mapped arguments {text}");
    assert!(!text.contains(STORED), "the stored credential is in {text}");
    assert_eq!(
        mapped,
        json!({ "query": "q", "filters": { "user_id": "alice" } })
    );
}

#[tokio::test]
async fn the_registry_hands_no_stored_credential_to_a_provider_binding() {
    // The store seals this key on `set` and decrypts it on `get`, as on a node.
    let (_directory, registry) =
        registry_with(&[("openrouter-api-key", STORED), ("mem0.user-id", "alice")]).await;
    let binding = binding_with(json!({
        "key": "pref:openrouter-api-key",
        "filters": { "user_id": "pref:mem0.user-id", "k": "pref: openrouter-api-key " },
    }));
    let resolved = Value::Object(registry.resolve_provider_defaults(&binding).await);
    let text = resolved.to_string();
    println!("CE41 resolve_provider_defaults returned {text}");
    assert!(!text.contains(STORED), "the stored credential is in {text}");
    assert_eq!(resolved, json!({ "filters": { "user_id": "alice" } }));
}

#[tokio::test]
async fn a_binding_whose_only_token_names_a_credential_sends_neither_value_nor_token() {
    let (_directory, registry) = registry_with(&[("openrouter-api-key", STORED)]).await;
    let binding = binding_with(json!({ "key": "pref:openrouter-api-key", "keep": 1 }));
    let resolved = Value::Object(registry.resolve_provider_defaults(&binding).await);
    let text = resolved.to_string();
    println!("CE41 resolve_provider_defaults returned {text}");
    assert!(!text.contains(STORED), "the stored credential is in {text}");
    assert_eq!(
        resolved,
        json!({ "keep": 1 }),
        "the token's own text drops too"
    );
}

// Guards. These pass with and without the fix.

#[test]
fn the_three_shipped_apps_name_exactly_their_seven_plain_keys() {
    let mut keys: Vec<String> = shipped_bindings()
        .iter()
        .flat_map(|(_, binding)| referenced_pref_keys(binding))
        .collect();
    keys.sort();
    keys.dedup();
    assert_eq!(keys, SHIPPED_KEYS.map(str::to_owned).to_vec());
    for key in SHIPPED_KEYS {
        assert!(
            !is_secret_preference_key(key),
            "{key} must stay a plain key"
        );
    }
    // Every token of the shipped text is in that list: none is skipped.
    for (_, raw) in SHIPPED {
        for token in raw.split("\"pref:").skip(1) {
            let key = token.split('"').next().unwrap_or_default().trim();
            assert!(SHIPPED_KEYS.contains(&key), "unlisted shipped key {key}");
        }
    }
}

#[test]
fn the_shipped_apps_still_resolve_their_own_keys() {
    let stored: BTreeMap<String, String> = SHIPPED_KEYS
        .iter()
        .map(|key| ((*key).to_owned(), format!("value-of-{key}")))
        .collect();
    let bindings = shipped_bindings();
    for app in ["codex-computer-use/", "honcho/", "mem0/"] {
        assert!(
            bindings.iter().any(|(name, binding)| name.starts_with(app)
                && !referenced_pref_keys(binding).is_empty()),
            "{app} ships no pref: token any more"
        );
    }
    for (name, binding) in &bindings {
        let text = Value::Object(resolve_arg_defaults(binding, &stored)).to_string();
        assert!(!text.contains("pref:"), "{name} keeps a token: {text}");
        for key in referenced_pref_keys(binding) {
            assert!(
                text.contains(&format!("\"value-of-{key}\"")),
                "{name} did not resolve {key}: {text}"
            );
        }
    }
}

#[tokio::test]
async fn the_registry_still_resolves_a_shipped_plain_key_and_passes_literals_through() {
    let (_directory, registry) = registry_with(&[("mem0.user-id", "alice")]).await;
    let (_, search) = shipped_bindings()
        .into_iter()
        .find(|(name, _)| name == "mem0/memory.search")
        .expect("mem0 ships memory.search with arg_defaults");
    let resolved = registry.resolve_provider_defaults(&search).await;
    assert_eq!(resolved["filters"]["user_id"], json!("alice"));

    // No token at all: the defaults pass through as they are.
    let literal = binding_with(json!({ "use_autoprompt": true, "mode": "prefer:fast" }));
    assert_eq!(
        registry.resolve_provider_defaults(&literal).await,
        literal.arg_defaults
    );
}
