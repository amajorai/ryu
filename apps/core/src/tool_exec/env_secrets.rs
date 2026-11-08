//! Which process-env and plugin secrets a plugin tool may read, and how
//! `env:`/`secret:` sources resolve.
//!
//! Split out of `tool_exec/mod.rs`; items are re-exported there, so
//! `crate::tool_exec::*` paths are unchanged.

/// One `env:`/`vault:` token's resolution within a `secret_headers` template.
///
/// `PartialEq`/`Debug` exist for the resolver's tests only — a real secret is
/// never logged, and nothing on a production path formats this type.
#[cfg_attr(test, derive(Debug, PartialEq, Eq))]
pub(super) enum SecretToken {
    /// The word is not a secret token — the caller keeps it verbatim (literal
    /// text such as the `Bearer` scheme prefix).
    Literal,
    /// The token resolved to a concrete secret value.
    Value(String),
    /// The token resolves to "absent" (missing env var / no bound vault
    /// connection / empty value) — the WHOLE header is then omitted.
    Absent,
}

/// Operator override naming the process env vars ANY plugin may read through an
/// `env:` secret-header token, comma/whitespace separated. Additive on top of the
/// per-plugin prefix below — the escape hatch for a deployment that wants a
/// Community plugin to reach a shared credential (`RYU_TOKEN`, a corporate proxy
/// key) without shipping it a Core-tier id.
pub(super) const ENV_SECRET_ALLOWLIST: &str = "RYU_PLUGIN_ENV_ALLOWLIST";

/// The per-plugin env-var prefix a Community-tier plugin may read from without any
/// operator configuration. Non-alphanumeric bytes use an explicit hex escape,
/// making the mapping injective: two different plugin ids can never share the
/// same credential namespace.
///
/// # Why the `RYU_PLUGIN_` infix rather than the bare `RYU_<ID>_` BYOK shape
///
/// The obvious rule — mirror the shape first-party manifests already author, where
/// `exa` reads `RYU_EXA_API_KEY` — puts the plugin namespace INSIDE Core's own
/// configuration namespace, and plugin ids are free-form (a bare kebab id like
/// `ghost` or `rtk` is legal, see `validate_plugin_id`). A plugin is therefore free
/// to name ITSELF after a Core config family and read that family's secrets: id
/// `master` → `RYU_MASTER_` ⊃ `RYU_MASTER_KEY`; id `gateway` → `RYU_GATEWAY_` ⊃
/// `RYU_GATEWAY_TOKEN`/`RYU_GATEWAY_KEY`; id `ext` → `RYU_EXT_TOKEN`; id `github` →
/// `RYU_GITHUB_TOKEN`; id `marketplace` → `RYU_MARKETPLACE_SIGNING_KEY`. None of
/// those ids is taken by a compiled-in fixture, so all are claimable by a disk
/// manifest, and the gate would have read as a fence while granting exactly the
/// credentials it exists to protect.
///
/// A denylist of Core's ~270 `RYU_*` vars would be hand-maintained and stale the
/// moment someone adds a var — the same failure mode the audit flagged for the
/// Gateway's hand-listed grant allowlist. Carving out a sub-namespace Core never
/// uses for its own configuration is structural instead: nothing in Core reads a
/// `RYU_PLUGIN_*` var except [`ENV_SECRET_ALLOWLIST`], which this gate refuses
/// explicitly.
///
/// Nothing first-party regresses: every in-repo manifest that authors an `env:`
/// secret header is compiled in, so it takes the provenance arm above and never
/// reaches this prefix at all. The rule binds only third-party disk plugins, which
/// simply name their BYOK var `RYU_PLUGIN_<THEIR_ID>_API_KEY`.
pub(super) fn plugin_env_prefix(plugin_id: &str) -> String {
    let mut out = String::with_capacity(plugin_id.len() + 12);
    out.push_str("RYU_PLUGIN_");
    for byte in plugin_id.trim().as_bytes() {
        if byte.is_ascii_alphanumeric() {
            out.push((*byte as char).to_ascii_uppercase());
        } else {
            out.push_str(&format!("_X{byte:02X}_"));
        }
    }
    out.push('_');
    out
}

/// Whether `plugin_id` may read the process env var `var` through an `env:`
/// secret-header token.
///
/// # Why this gate exists
///
/// `secret_headers` resolves server-side and its VALUES are deliberately excluded
/// from the firewall/DLP scan and the audit trail (a secret must not land in a log),
/// so an `env:` read is an invisible transfer. Unrestricted, a manifest in the
/// user-writable `~/.ryu/plugins` could pair `secret_headers: {"X-K":
/// "env:ANTHROPIC_API_KEY"}` (or `RYU_MASTER_KEY`, or a gateway token) with a URL it
/// controls and exfiltrate a credential the user never knew it could see.
///
/// App dispatch first filters sources with [`restrict_backend_env_sources`],
/// binding shared-variable access to the actual compiled manifest bytes. This
/// lower-level gate also handles host-generated requests and scoped variables:
///
/// - A **compiled-in** manifest (`plugin_manifest/fixtures/*.manifest.json`, embedded
///   with `include_str!`) reads any var. Its bytes ship inside the binary, and
///   several of them legitimately read a SHARED var that fits no per-plugin prefix:
///   `@ryu/advisor` and `shadow` both authenticate to loopback Core with
///   `env:RYU_TOKEN`. Note this is deliberately NOT `tier_for` — `exa`, `rtk` and
///   `@ryu/advisor` are all Community-tier yet compiled in, so a tier check
///   would break three first-party tools while protecting nothing extra.
/// - A **disk** manifest (`~/.ryu/plugins/<id>/manifest.json`, which the loader
///   validates for semver + id uniqueness and nothing else) reads only its own
///   [`plugin_env_prefix`] namespace, plus whatever an operator names in
///   [`ENV_SECRET_ALLOWLIST`]. Fail-closed.
///
/// Provenance rather than a grant because there is no per-var approval to read: the
/// Gateway vets grant STRINGS, and no grant vocabulary describes "may read env var
/// X". Tightening the namespace is the control that exists.
pub(crate) fn may_read_env_secret(plugin_id: &str, var: &str) -> bool {
    if crate::plugins::builtins::is_compiled_in_manifest(plugin_id) {
        return true;
    }
    may_read_scoped_env_secret(plugin_id, var)
}

pub(super) fn may_read_scoped_env_secret(plugin_id: &str, var: &str) -> bool {
    // The allowlist var itself is never readable through the gate it configures:
    // a plugin whose id encodes to the `env` namespace would otherwise sit exactly on
    // `RYU_PLUGIN_ENV_` and read the policy naming its own escape hatch.
    if var == ENV_SECRET_ALLOWLIST {
        return false;
    }
    if var.starts_with(&plugin_env_prefix(plugin_id)) {
        return true;
    }
    std::env::var(ENV_SECRET_ALLOWLIST).ok().is_some_and(|raw| {
        raw.split([',', ' ', '\t', '\n', ';'])
            .map(str::trim)
            .any(|entry| !entry.is_empty() && entry == var)
    })
}

/// Check environment sources against the manifest that actually owns execution.
/// Catalog membership of its id cannot establish provenance of installed bytes.
pub(crate) fn restrict_backend_env_sources(
    manifest: &crate::plugin_manifest::PluginManifest,
    backend: &mut crate::plugin_manifest::schema::ToolBackend,
) {
    if crate::plugins::builtins::is_exact_compiled_manifest(manifest) {
        return;
    }
    let allowed = |source: &str| {
        source.split_whitespace().all(|word| {
            word.strip_prefix("env:")
                .is_none_or(|var| may_read_scoped_env_secret(&manifest.id, var))
        })
    };
    match backend {
        crate::plugin_manifest::schema::ToolBackend::Http { secret_headers, .. } => {
            secret_headers.retain(|_, source| allowed(source));
        }
        crate::plugin_manifest::schema::ToolBackend::Command { env, .. } => {
            env.retain(|_, source| allowed(source));
        }
        _ => {}
    }
}

/// Resolve an `env:VARNAME` token to its value, from the process environment or —
/// when the process has none — from the encrypted per-plugin secret store.
///
/// # Why the store is reached under the SAME name
///
/// A BYOK plugin declares its key as `env:RYU_TAVILY_API_KEY` today. Introducing a
/// second grammar (`secret:RYU_TAVILY_API_KEY`) would mean every existing manifest
/// had to be edited before its key became settable from the UI — including
/// third-party ones nobody here can edit. Falling back under the identical name
/// makes every plugin that already ships an `env:` token UI-configurable with ZERO
/// manifest changes, which is the whole point of
/// [`crate::plugin_secrets`].
///
/// # Precedence: live node token, then process env, then store
///
/// `RYU_TOKEN` is Core's internal self-call credential. Runtime rotation updates
/// [`crate::node_token::active_token`] without mutating the multithreaded process
/// environment, so that one name resolves from live state. For every other name,
/// an operator who exports a var in the service unit / shell profile expects that
/// value to be the one in effect, and expects `env | grep` to explain what the
/// process is doing. If the store won, a forgotten UI entry would silently shadow
/// the deployment's configuration and there would be nothing in the environment to
/// point at. So env wins and the store is the fallback — the UI is how you set a
/// key you have *not* otherwise configured, never a way to override one you have.
///
/// # The namespace gate runs FIRST, before either source
///
/// [`may_read_env_secret`] restricts which names a disk manifest may name at all
/// (its own [`plugin_env_prefix`] namespace plus the operator allowlist). It must
/// gate the store lookup exactly as it gates the env read: without it, plugin A
/// could name plugin B's key and — because the store is keyed by the CALLING
/// plugin id — at minimum probe for, and at worst harvest, credentials outside its
/// namespace. The gate is applied once, above the branch, so no future source can
/// be added below it and miss the check.
///
/// `store` is passed in rather than read from the global so tests can exercise the
/// real precedence against an in-memory store; production callers pass
/// [`crate::plugin_secrets::global`].
pub(super) async fn resolve_env_secret_from(
    plugin_id: &str,
    var: &str,
    store: Option<&crate::plugin_secrets::PluginSecretStore>,
) -> SecretToken {
    // Ungated var → treated exactly like "unset": the header is omitted and the
    // tool surfaces its own auth error. Refusing loudly here would leak which
    // env vars this Core process happens to carry.
    if !may_read_env_secret(plugin_id, var) {
        tracing::warn!(
            "plugin '{plugin_id}' requested env var '{var}' in a secret header, but it is \
             outside the plugin's '{}' namespace and not on the '{ENV_SECRET_ALLOWLIST}' \
             operator allowlist; the header is omitted",
            plugin_env_prefix(plugin_id)
        );
        return SecretToken::Absent;
    }
    let live_node_token = (var == "RYU_TOKEN")
        .then(crate::node_token::active_token)
        .flatten();
    let environment_value = std::env::var(var).ok();
    if let Some(v) = resolve_process_env_value(
        var,
        live_node_token.as_deref(),
        environment_value.as_deref(),
    ) {
        return SecretToken::Value(v);
    }
    let Some(store) = store else {
        return SecretToken::Absent;
    };
    match store.get(plugin_id, var).await {
        Ok(Some(v)) if !v.is_empty() => SecretToken::Value(v),
        Ok(_) => SecretToken::Absent,
        Err(e) => {
            // Storage failure is "absent", not a hard error: same soft-omit posture
            // as an unset var, so a broken db degrades to the pre-store behaviour.
            tracing::warn!("reading plugin secret '{var}' for '{plugin_id}' failed: {e:#}");
            SecretToken::Absent
        }
    }
}

/// Resolve an explicitly declared sidecar environment reference using the same
/// plugin namespace and encrypted-store precedence as HTTP credentials.
/// Callers must apply reserved sidecar environment values after this result.
pub(crate) async fn resolve_sidecar_env_source(
    plugin_id: &str,
    source: &str,
    store: Option<&crate::plugin_secrets::PluginSecretStore>,
    manifest: Option<&crate::plugin_manifest::PluginManifest>,
) -> Option<String> {
    let var = source.strip_prefix("env:")?;
    let trusted = manifest.is_some_and(|manifest| {
        manifest.id == plugin_id && crate::plugins::builtins::is_exact_compiled_manifest(manifest)
    });
    if !trusted && !may_read_scoped_env_secret(plugin_id, var) {
        return None;
    }
    match resolve_env_secret_from(plugin_id, var, store).await {
        SecretToken::Value(value) => Some(value),
        SecretToken::Absent | SecretToken::Literal => None,
    }
}

pub(super) fn resolve_process_env_value(
    var: &str,
    live_node_token: Option<&str>,
    environment_value: Option<&str>,
) -> Option<String> {
    let value = if var == "RYU_TOKEN" {
        live_node_token
    } else {
        environment_value
    };
    value.filter(|value| !value.is_empty()).map(str::to_owned)
}
