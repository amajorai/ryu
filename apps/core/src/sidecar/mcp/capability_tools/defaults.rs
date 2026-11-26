//! Layer defaults: per-argument preference keys, type coercion, `pref:`
//! tokens in provider defaults, and the merge order (caller over layer default
//! over provider default).

use super::*;

/// The preference key holding the user's default for one canonical argument of a
/// capability — e.g. `layer.web.search.default.limit`.
///
/// Deliberately ONE KEY PER ARGUMENT rather than a single JSON blob per capability.
/// Preferences store bare strings and the settings-field types (`number`, `select`,
/// `toggle`, …) each write one scalar, so per-argument keys are authorable from a
/// plain manifest `settings_tabs` entry with no new field type and no client-side
/// JSON assembly. The cost is one small read per argument at call time, which is
/// nothing next to the network call the verb is about to make.
pub fn layer_default_key(capability: &str, arg: &str) -> String {
    format!("layer.{capability}.default.{arg}")
}

/// The canonical argument names of a verb, read off its own input schema — the set
/// of arguments a user may set a layer default for.
pub fn canonical_args(verb: &Verb) -> Vec<String> {
    (verb.schema)()
        .get("properties")
        .and_then(Value::as_object)
        .map(|props| props.keys().cloned().collect())
        .unwrap_or_default()
}

/// Coerce a stored preference string into the JSON type the canonical schema
/// declares for that argument.
///
/// Preferences are strings, but a verb argument may be an integer, a number or a
/// boolean, and forwarding `"20"` where the provider expects `20` is the kind of
/// mismatch that produces a confusing upstream 400. A value that does not parse as
/// its declared type is DROPPED rather than passed through as a string: a malformed
/// preference must not turn into a malformed API call.
pub fn coerce_to_schema_type(verb: &Verb, arg: &str, raw: &str) -> Option<Value> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let schema = (verb.schema)();
    let declared = schema
        .get("properties")
        .and_then(Value::as_object)
        .and_then(|p| p.get(arg))
        .and_then(|p| p.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("string");
    match declared {
        "integer" => raw.parse::<i64>().ok().map(Value::from),
        "number" => raw.parse::<f64>().ok().map(Value::from),
        "boolean" => match raw {
            "true" => Some(Value::Bool(true)),
            "false" => Some(Value::Bool(false)),
            _ => None,
        },
        // `array` and `object` defaults are not expressible as a scalar preference,
        // so they are simply not offered rather than half-parsed.
        "array" | "object" => None,
        _ => Some(Value::String(raw.to_owned())),
    }
}

/// The prefix marking an [`CapabilityToolBinding::arg_defaults`] value as a
/// PREFERENCE reference rather than a literal.
pub const PREF_TOKEN: &str = "pref:";

/// Every preference key referenced by a binding's `arg_defaults`, at any depth.
///
/// Providers need per-install configuration that is NOT a canonical verb argument —
/// Mem0 scopes every read to an entity id that lives inside its `filters` object, and
/// no canonical memory verb has (or should have) such a field. Without this a manifest
/// can only hard-code the value, which means one fixed bucket for every install: the
/// provider then returns nothing, forever, silently. That is the same
/// silently-serves-nothing failure a provider with no verbs would cause.
///
/// A key that names a credential-bearing preference is left out, so dispatch never
/// reads (and the store never decrypts) it for a token. See [`refused_pref_keys`].
pub fn referenced_pref_keys(binding: &CapabilityToolBinding) -> Vec<String> {
    pref_keys(binding, false)
}

/// Whether a `pref:` token must NOT resolve this preference key.
///
/// A provider's `arg_defaults` go to the provider's own tool as they resolve, and
/// no grant names that read. A credential-bearing preference (an API key, a bearer
/// token) must never travel that way, so a token that names one is treated like a
/// token with no stored value. The test is the preferences store's OWN one, the
/// same `host.getPreference` applies, asked with the trimmed key the store would
/// be read with. There is no second list of names here to keep in step.
fn is_refused_pref_key(key: &str) -> bool {
    crate::server::preferences::is_secret_preference_key(key.trim())
}

/// Every key named by a `pref:` token in a binding's `arg_defaults`, at any depth,
/// trimmed: the ones a token may resolve (`refused == false`) or the
/// credential-bearing ones it may not (`refused == true`).
fn pref_keys(binding: &CapabilityToolBinding, refused: bool) -> Vec<String> {
    fn walk(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(s) => {
                if let Some(key) = s.strip_prefix(PREF_TOKEN) {
                    let key = key.trim();
                    if !key.is_empty() {
                        out.push(key.to_owned());
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|v| walk(v, out)),
            Value::Object(map) => map.values().for_each(|v| walk(v, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    for value in binding.arg_defaults.values() {
        walk(value, &mut out);
    }
    out.retain(|key| is_refused_pref_key(key) == refused);
    out.sort();
    out.dedup();
    out
}

/// The credential-bearing preference keys a binding's `pref:` tokens name. They
/// never resolve: [`referenced_pref_keys`] leaves them out and
/// [`resolve_arg_defaults`] drops their arguments.
pub fn refused_pref_keys(binding: &CapabilityToolBinding) -> Vec<String> {
    pref_keys(binding, true)
}

/// Refuse a manifest whose provider bindings name a credential-bearing preference
/// in a `pref:` token, with a sentence for the app's author.
///
/// This is the visible half only. A manifest that reaches Core some other way is
/// still safe, because the token never resolves at call time.
pub fn refuse_secret_pref_tokens(manifest: &PluginManifest) -> Result<(), String> {
    for entry in manifest.provided_capabilities() {
        for (verb, binding) in &entry.tools {
            if let Some(key) = refused_pref_keys(binding).first() {
                return Err(format!(
                    "app '{}' maps '{verb}' with an argument default that names the \
                     credential-bearing preference '{key}' in a pref: token; a pref: token \
                     cannot read a credential, use the governed secret-header or vault \
                     capability instead",
                    manifest.id
                ));
            }
        }
    }
    Ok(())
}

/// Substitute `pref:<key>` tokens in a binding's `arg_defaults` with their stored
/// values, returning the resolved defaults.
///
/// A key with no stored value keeps whatever the manifest declared AFTER the token —
/// there is no such thing, so the token itself would be sent. Rather than ship a
/// literal `"pref:mem0.user-id"` upstream, an unresolved token DROPS its argument, so
/// the provider sees a missing field and can say so, instead of a nonsense value it
/// will treat as real.
///
/// A token that names a credential-bearing preference drops its argument the same
/// way, EVEN WHEN `prefs` holds a value for that key: the refusal does not depend
/// on the caller having left the key unread.
pub fn resolve_arg_defaults(
    binding: &CapabilityToolBinding,
    prefs: &BTreeMap<String, String>,
) -> Map<String, Value> {
    fn subst(value: &Value, prefs: &BTreeMap<String, String>) -> Option<Value> {
        match value {
            Value::String(s) => match s.strip_prefix(PREF_TOKEN) {
                Some(key) if is_refused_pref_key(key) => None,
                Some(key) => prefs
                    .get(key.trim())
                    .filter(|v| !v.trim().is_empty())
                    .map(|v| Value::String(v.clone())),
                None => Some(value.clone()),
            },
            Value::Array(items) => Some(Value::Array(
                items.iter().filter_map(|v| subst(v, prefs)).collect(),
            )),
            Value::Object(map) => {
                let mut out = Map::new();
                for (k, v) in map {
                    if let Some(resolved) = subst(v, prefs) {
                        out.insert(k.clone(), resolved);
                    }
                }
                Some(Value::Object(out))
            }
            other => Some(other.clone()),
        }
    }
    let mut out = Map::new();
    for (name, value) in &binding.arg_defaults {
        if let Some(resolved) = subst(value, prefs) {
            out.insert(name.clone(), resolved);
        }
    }
    out
}

/// Merge the user's per-layer argument defaults underneath the caller's arguments.
///
/// Precedence is **caller > layer default > provider `arg_defaults`**. The user's
/// layer default outranks the provider's because it is an explicit choice about how
/// this layer should behave ("search returns 25 results"), whereas a provider's
/// `arg_defaults` is vendor-specific tuning that should give way to it. An explicit
/// caller argument beats both — a model asking for 5 results gets 5.
pub fn apply_layer_defaults(defaults: &Map<String, Value>, arguments: Value) -> Value {
    if defaults.is_empty() {
        return arguments;
    }
    let mut merged = defaults.clone();
    match arguments {
        Value::Object(caller) => {
            for (k, v) in caller {
                merged.insert(k, v);
            }
            Value::Object(merged)
        }
        // A non-object payload has no named arguments to merge into; the caller's
        // value stands rather than being silently replaced by defaults.
        other => other,
    }
}

#[cfg(test)]
mod refusal_tests {
    use super::*;
    use crate::plugin_manifest::ProvidesEntry;
    use crate::server::preferences::is_secret_preference_key;

    fn provider(arg_defaults: Value) -> PluginManifest {
        let binding: CapabilityToolBinding = serde_json::from_value(json!({
            "tool": "acme.search",
            "arg_defaults": arg_defaults,
        }))
        .expect("the manifest form must deserialize");
        PluginManifest {
            id: "@acme/search".to_owned(),
            name: "Acme".to_owned(),
            version: "1.0.0".to_owned(),
            provides: vec![ProvidesEntry {
                capability: CAP_WEB_SEARCH.to_owned(),
                version: "1.0.0".to_owned(),
                tools: [("web.search".to_owned(), binding)].into_iter().collect(),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn the_refusal_is_the_stores_own_secret_test_on_the_trimmed_key() {
        // No list of names lives in this module. Whatever the store seals is
        // refused, whatever it stores as plain text may resolve.
        for key in [
            "openrouter-api-key",
            "managed-gateway-token",
            "github-api-token",
            "hf-token",
            "smtp-password",
            "acp-agent-settings",
            "mem0.user-id",
            "honcho.workspace-id",
            "theme",
        ] {
            let manifest = provider(json!({ "a": format!("pref: {key} ") }));
            let binding = &manifest.provides[0].tools["web.search"];
            let secret = is_secret_preference_key(key);
            assert_eq!(refused_pref_keys(binding).contains(&key.to_owned()), secret);
            assert_eq!(
                referenced_pref_keys(binding).contains(&key.to_owned()),
                !secret,
                "{key}"
            );
        }
    }

    #[test]
    fn refused_pref_keys_finds_a_credential_key_at_any_depth() {
        let manifest = provider(json!({
            "user": "pref:mem0.user-id",
            "nested": { "list": [{ "k": "pref: hf-token " }] },
            "auth": "pref:openrouter-api-key",
            "again": "pref:openrouter-api-key",
        }));
        let binding = &manifest.provides[0].tools["web.search"];
        assert_eq!(
            refused_pref_keys(binding),
            vec!["hf-token".to_owned(), "openrouter-api-key".to_owned()]
        );
        assert_eq!(
            referenced_pref_keys(binding),
            vec!["mem0.user-id".to_owned()]
        );
    }

    #[test]
    fn a_manifest_that_names_a_credential_in_a_pref_token_is_refused_by_name() {
        let manifest = provider(json!({ "filters": { "t": "pref:managed-gateway-token" } }));
        let refusal = refuse_secret_pref_tokens(&manifest).expect_err("must be refused");
        for part in ["@acme/search", "web.search", "managed-gateway-token"] {
            assert!(
                refusal.contains(part),
                "the refusal names {part}: {refusal}"
            );
        }
    }

    #[test]
    fn a_manifest_with_ordinary_pref_tokens_or_none_is_accepted() {
        let ordinary = provider(json!({ "user_id": "pref:mem0.user-id", "infer": false }));
        assert_eq!(refuse_secret_pref_tokens(&ordinary), Ok(()));
        assert_eq!(refuse_secret_pref_tokens(&provider(json!({}))), Ok(()));
        assert_eq!(
            refuse_secret_pref_tokens(&PluginManifest::default()),
            Ok(())
        );
    }

    #[test]
    fn no_shipped_manifest_is_refused_at_install() {
        // The install refusal must not lock out an app Ryu ships.
        use crate::plugin_manifest::PluginManifestLoader as Loader;
        let mut shipped = Loader::load_builtins();
        shipped.extend(Loader::load_install_catalog());
        assert!(!shipped.is_empty());
        for manifest in shipped {
            assert_eq!(
                refuse_secret_pref_tokens(&manifest),
                Ok(()),
                "{}",
                manifest.id
            );
        }
    }
}
