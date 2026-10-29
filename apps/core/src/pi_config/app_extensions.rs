//! Plugin-contributed Pi extensions: enabled plugin manifests → one resolved set
//! the managed Pi's `extensions/` dir is projected onto.
//!
//! A plugin declares an extension in `contributes.pi_extensions`
//! ([`PiExtensionContribution`]) and ships the TypeScript beside its manifest. This
//! module decides which of those declarations a node may actually run, resolves each
//! one's source, and hands the result to [`super::sync_app_pi_extensions`], which
//! owns the disk projection.
//!
//! # Why this lives under `pi_config` and not beside [`crate::lsp`]
//!
//! `lsp.rs` is split out because `contributes.lsp_servers` is genuinely
//! agent-neutral: the declaration says "run gopls", and the managed Pi is only one
//! possible binding for it. A Pi extension has no agent-neutral half — the file is
//! TypeScript against Pi's own extension API, and there is nothing a second agent
//! could bind it to. So the resolver and the binding are one module, inside the
//! module that already owns `~/.ryu/pi-agent`.
//!
//! # Restart semantics
//!
//! Pi reads its extensions when the process boots, so a change here lands on the
//! next Pi **process**, not the next turn — and the managed Pi is pooled per
//! `(conversation, agent, spawn_cmd, cwd)` with its ACP session built once per
//! instance. Enabling or disabling a plugin therefore takes effect in a NEW chat (or
//! after an agent switch, an idle-TTL expiry, a crash, or a Core restart), never
//! mid-conversation. Same posture as [`crate::lsp::ensure_lsp_servers_materialized`],
//! and for the same reason: there is nothing to send a live Pi that would make it
//! re-read.

use std::collections::{HashMap, HashSet};

use crate::plugin_manifest::{
    plugin_dir_name, validate_pi_extension_path, PluginManifest, PluginTier, MAX_CODE_FILE_BYTES,
};
use crate::server::ServerState;

/// The grant a **Community**-tier plugin needs before Core will materialize its
/// `contributes.pi_extensions`.
///
/// A Pi extension is not sandboxed code. A `turn_hooks` body runs in the
/// deny-by-default JS sandbox behind capability-gated `host.*`; a file named here
/// is loaded by the Pi process itself with full host privilege — the first-party
/// ones spawn child processes and POST to Core. That is the same
/// arbitrary-code-execution class as [`crate::sidecar::mcp::GRANT_MCP_SERVER`], so
/// it gets the same treatment: a reserved namespace, off the Gateway's default
/// allowlist, reachable only when an operator adds it to
/// `RYU_MARKETPLACE_GRANT_ALLOWLIST`.
pub const GRANT_PI_EXTENSION: &str = "pi:extension";

/// Prefix on every file name this module writes into the managed Pi's
/// `extensions/` dir.
///
/// **The ownership boundary, not decoration.** Pi auto-discovers that whole
/// directory, which already holds the compiled-in `ryu-*.ts` extensions and may hold
/// files a user dropped in by hand. The reconciler adds and deletes only names
/// carrying this prefix, so a plugin set that resolves to nothing can never delete
/// the flagship agent's MCP bridge.
pub const APP_EXTENSION_PREFIX: &str = "ext-";

/// Whether a plugin may ship its manifest-declared `pi_extensions`.
///
/// **Core**-tier (compiled-in manifests) is auto-allowed: those manifests ship
/// inside the binary and cannot be edited on disk (the loader parses built-ins FIRST
/// and first-occurrence-wins, so a disk manifest can never take a Core id).
/// **Community**-tier — anything loaded from `~/.ryu/plugins` — needs the approved
/// [`GRANT_PI_EXTENSION`] grant.
///
/// `approved_grants` MUST be the Gateway-approved set
/// ([`crate::plugins::PluginRecord::approved_grants`]), never the manifest's
/// declared, unvalidated `permission_grants`. Fail-closed. Pure, so the gate is
/// unit-tested without a live enable — mirrors
/// [`crate::sidecar::mcp::may_register_mcp_servers`] exactly.
pub fn may_ship_pi_extensions(tier: PluginTier, approved_grants: &[String]) -> bool {
    match tier {
        PluginTier::Core => true,
        PluginTier::Community => approved_grants.iter().any(|g| g == GRANT_PI_EXTENSION),
    }
}

/// One extension that survived the gate and whose source resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedPiExtension {
    /// The plugin that declared it — carried so a skip message can name a culprit
    /// the user can act on.
    pub plugin_id: String,
    /// The id the plugin filed it under in `contributes.pi_extensions`.
    pub extension_id: String,
    /// The name it is written under in the managed Pi's `extensions/` dir, always
    /// [`APP_EXTENSION_PREFIX`]-prefixed.
    pub file_name: String,
    /// The TypeScript source, already read from the embed table or the plugin dir.
    pub source: String,
}

impl ResolvedPiExtension {
    /// The stable identity of this extension across the node:
    /// `<plugin id>/<extension id>`. Qualified unconditionally for the same reason
    /// [`crate::lsp::ResolvedLspServer::key`] is.
    pub fn key(&self) -> String {
        format!("{}/{}", self.plugin_id, self.extension_id)
    }
}

/// One declaration that will NOT be materialized, and why — in words meant for a
/// human. Every drop produces one; silently discarding an extension the user
/// enabled a plugin for is the failure mode this type exists to prevent.
#[derive(Debug, Clone, PartialEq)]
pub struct PiExtensionSkip {
    /// `<plugin id>/<extension id>` — see [`ResolvedPiExtension::key`].
    pub key: String,
    /// Human-facing reason.
    pub reason: String,
}

/// What a node's enabled plugin set resolves to: what gets written, and what does
/// not.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PiExtensionResolution {
    /// Extensions to materialize, in `(plugin id ascending, extension id ascending)`
    /// order.
    pub extensions: Vec<ResolvedPiExtension>,
    /// Every dropped declaration with its reason.
    pub skipped: Vec<PiExtensionSkip>,
}

impl PiExtensionResolution {
    /// The file names this resolution owns — the keep-set the reconciler diffs the
    /// managed dir against.
    pub fn file_names(&self) -> HashSet<String> {
        self.extensions
            .iter()
            .map(|ext| ext.file_name.clone())
            .collect()
    }
}

/// The materialized file name for one declaration.
///
/// `ext-<flattened plugin id>-<extension id>.ts`. The plugin half is flattened by
/// [`plugin_dir_name`] because a scoped id contains `/`, which would turn a file
/// name into a nested path.
fn file_name_for(plugin_id: &str, extension_id: &str) -> String {
    format!(
        "{APP_EXTENSION_PREFIX}{}-{extension_id}.ts",
        plugin_dir_name(plugin_id)
    )
}

/// Resolve every enabled plugin's `contributes.pi_extensions` into one set.
///
/// Pure over `(manifests, enabled grants, source resolver)` so the gate and the
/// collision rule are unit-testable without a running server or a filesystem;
/// [`resolve_for_node`] is the thin async wrapper that supplies all three.
///
/// `enabled` maps an enabled plugin id to its **Gateway-approved** grants. Tier
/// comes from [`crate::plugins::builtins::tier_for`], which is a lookup in a
/// compiled-in const, so it stays pure.
///
/// Sorted by plugin id then extension id, for the same reason
/// [`crate::lsp::resolve_lsp_servers`] is: the manifest list is built from
/// compiled-in built-ins followed by a `read_dir`, whose order is not stable across
/// machines, and the collision rule below would otherwise resolve differently on two
/// nodes with the identical plugin set.
pub fn resolve_pi_extensions(
    manifests: &[PluginManifest],
    enabled: &HashMap<String, Vec<String>>,
    mut resolve_source: impl FnMut(&str, &str) -> Result<String, String>,
) -> PiExtensionResolution {
    let mut candidates: Vec<&PluginManifest> = manifests
        .iter()
        .filter(|m| enabled.contains_key(&m.id))
        .filter(|m| {
            m.contributes
                .as_ref()
                .is_some_and(|c| !c.pi_extensions.is_empty())
        })
        .collect();
    candidates.sort_by(|a, b| a.id.cmp(&b.id));

    let mut resolution = PiExtensionResolution::default();
    // file name → the key that already owns it.
    let mut owners: HashMap<String, String> = HashMap::new();

    for manifest in candidates {
        let Some(contributes) = manifest.contributes.as_ref() else {
            continue;
        };
        let grants = enabled.get(&manifest.id).map(Vec::as_slice).unwrap_or(&[]);
        let tier = crate::plugins::builtins::tier_for_manifest(manifest);
        if !may_ship_pi_extensions(tier, grants) {
            for ext in &contributes.pi_extensions {
                resolution.skipped.push(PiExtensionSkip {
                    key: format!("{}/{}", manifest.id, ext.id),
                    reason: format!(
                        "plugin '{}' is {tier:?}-tier and has no approved '{GRANT_PI_EXTENSION}' \
                         grant, so its Pi extension is not shipped (fail-closed) — a Pi extension \
                         runs unsandboxed inside the agent process",
                        manifest.id
                    ),
                });
            }
            continue;
        }

        let mut sorted: Vec<_> = contributes.pi_extensions.iter().collect();
        sorted.sort_by(|a, b| a.id.cmp(&b.id));
        for ext in sorted {
            let key = format!("{}/{}", manifest.id, ext.id);
            // Re-checked here even though `PluginManifest::validate` already ran it:
            // this is the last gate before the path is joined onto a plugin
            // directory, and the resolver is also reachable from tests and any
            // future caller that builds a manifest in memory.
            if let Err(reason) = validate_pi_extension_path(&ext.file) {
                resolution.skipped.push(PiExtensionSkip { key, reason });
                continue;
            }

            let file_name = file_name_for(&manifest.id, &ext.id);
            // `ext-<dir>-<id>.ts` is ambiguous across `-` boundaries: plugin `a` with
            // extension `b-c` and plugin `a-b` with extension `c` flatten onto one
            // name. Rare, but a silent overwrite of one plugin's code by another's is
            // not a failure mode worth leaving to chance.
            if let Some(owner) = owners.get(&file_name) {
                resolution.skipped.push(PiExtensionSkip {
                    key,
                    reason: format!(
                        "pi extension would be written as '{file_name}', which '{owner}' already \
                         owns (first registration wins) — rename the extension id"
                    ),
                });
                continue;
            }

            let source = match resolve_source(&manifest.id, &ext.file) {
                Ok(source) => source,
                Err(reason) => {
                    resolution.skipped.push(PiExtensionSkip { key, reason });
                    continue;
                }
            };

            owners.insert(file_name.clone(), key);
            resolution.extensions.push(ResolvedPiExtension {
                plugin_id: manifest.id.clone(),
                extension_id: ext.id.clone(),
                file_name,
                source,
            });
        }
    }

    resolution
}

/// Read one declared extension's source, from the one place that can hold it for
/// this plugin's provenance.
///
/// The same fork as [`crate::plugin_manifest::hydrate_manifest_code_files`], and not
/// cosmetic: a built-in ships only its `manifest.json`, so its package directory is
/// not on the user's machine and the bytes must be compiled in. Table FIRST rather
/// than disk-first, because the loader parses built-ins first and rejects duplicate
/// ids, so a disk manifest can never claim a built-in id — the table is therefore
/// authoritative wherever it answers, and a Community plugin cannot shadow one.
///
/// Known gap on the Community path: `ryu pack` emits a single JSON bundle, so a
/// plugin installed from one arrives WITHOUT its `pi-extensions/` directory and the
/// read below fails. That is a visible skip with a reason, not a silent empty file —
/// and it is the same carriage gap `skills_catalog::plugin_skills` already has.
/// Closing it needs a real sidecar-file carriage in pack, not an inline `code` twin.
fn read_source(plugin_id: &str, rel: &str) -> Result<String, String> {
    if let Some(embedded) = crate::plugin_manifest::builtin_pi_extension(plugin_id, rel) {
        return Ok(embedded.to_owned());
    }
    let package_dir = crate::plugin_manifest::PluginManifestLoader::plugins_dir()
        .join(plugin_dir_name(plugin_id));
    let dir = package_dir.join(rel);
    let source = crate::plugin_manifest::read_contained_package_file(&package_dir, rel).map_err(|e| {
        format!(
            "cannot read pi extension '{rel}' for '{plugin_id}' ({}): {e} — a built-in must \
             instead carry an include_str! row in plugin_manifest::builtin_code::BUILTIN_PI_EXTENSIONS",
            dir.display()
        )
    })?;
    if source.len() > MAX_CODE_FILE_BYTES {
        return Err(format!(
            "pi extension '{rel}' is {} bytes (max {MAX_CODE_FILE_BYTES})",
            source.len()
        ));
    }
    Ok(source)
}

/// [`resolve_pi_extensions`] over the node's live plugin set: the enabled lifecycle
/// records (with their Gateway-approved grants) intersected with the in-memory
/// manifest list.
///
/// Reads `app_manifests` rather than re-walking the plugins dir, and filters before
/// cloning — this runs on every managed-Pi spawn, and a node with dozens of plugins
/// would otherwise deep-clone every manifest to read the handful that declare one.
/// Same shape as [`crate::lsp::resolve_for_node`].
pub async fn resolve_for_node(state: &ServerState) -> PiExtensionResolution {
    let Ok(records) = state.app_store.list().await else {
        return PiExtensionResolution::default();
    };
    let mut enabled: HashMap<String, Vec<String>> = records
        .iter()
        .filter(|r| r.enabled)
        .map(|r| (r.id.clone(), r.approved_grants.clone()))
        .collect();

    let manifests = state.app_manifests.read().await;
    let candidates: Vec<PluginManifest> = manifests
        .iter()
        .filter(|m| enabled.contains_key(&m.id))
        .filter(|m| {
            m.contributes
                .as_ref()
                .is_some_and(|c| !c.pi_extensions.is_empty())
        })
        .cloned()
        .collect();
    drop(manifests);

    // Local revocation and the opt-in trust requirement for host access. Pi
    // extensions run with the Pi process's full host privilege, so a refused
    // plugin ships none of them; each drop is reported like any other skip.
    let mut refused = Vec::new();
    if !candidates.is_empty() {
        let policy = crate::plugins::isolation::load_trust_policy(Some(&state.app_store)).await;
        for manifest in &candidates {
            let record = records.iter().find(|r| r.id == manifest.id);
            let version = record.map_or(manifest.version.as_str(), |r| r.version.as_str());
            let provenance = record.and_then(|r| r.provenance.as_ref());
            if let Some(refusal) = policy.host_access_refusal(manifest, version, provenance) {
                enabled.remove(&manifest.id);
                refused.extend(refused_skips(manifest, &refusal.to_string()));
            }
        }
    }

    let mut resolution = resolve_pi_extensions(&candidates, &enabled, read_source);
    resolution.skipped.extend(refused);
    resolution
}

/// One skip per declared extension of a plugin whose host access was refused.
fn refused_skips(manifest: &PluginManifest, reason: &str) -> Vec<PiExtensionSkip> {
    manifest
        .contributes
        .iter()
        .flat_map(|c| c.pi_extensions.iter())
        .map(|ext| PiExtensionSkip {
            key: format!("{}/{}", manifest.id, ext.id),
            reason: format!("plugin '{}': {reason}", manifest.id),
        })
        .collect()
}

/// Project the node's resolved extension set onto the managed Pi's config dir, so
/// the next Pi spawn loads exactly the enabled plugins' extensions.
///
/// Called from the ACP spawn path under its existing managed-Pi gate. Three
/// properties are load-bearing, and they are the same three
/// [`crate::lsp::ensure_lsp_servers_materialized`] documents:
///
/// - **Fail-open.** No published `ServerState` (unit tests, any headless path that
///   never built a server) means no materialisation — never a panic, never a failed
///   spawn.
/// - **Best-effort.** A write failure warns and the agent starts without the
///   extension. An enhancement must not be able to take the flagship agent down.
/// - **Read at process start, so written at process start.** See this module's
///   restart note: a toggle lands in a NEW chat, not on the next message of an open
///   one. Do not "fix" that by moving the write into the per-turn loop.
pub async fn ensure_pi_extensions_materialized() {
    let Some(state) = crate::learning::global_state() else {
        return;
    };
    let resolution = resolve_for_node(&state).await;
    for skip in &resolution.skipped {
        tracing::warn!(target: "pi_extensions", plugin = %skip.key, "{}", skip.reason);
    }
    if let Err(err) = super::sync_app_pi_extensions(&resolution) {
        tracing::warn!(target: "pi_extensions", "materialize plugin Pi extensions: {err:#}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::{Contributes, PiExtensionContribution};

    /// A manifest declaring `ids` as extensions, all pointing at `<id>.ts`.
    fn manifest(id: &str, ids: &[&str]) -> PluginManifest {
        let mut m = PluginManifest {
            id: id.to_owned(),
            version: "1.0.0".to_owned(),
            ..Default::default()
        };
        m.contributes = Some(Contributes {
            pi_extensions: ids
                .iter()
                .map(|e| PiExtensionContribution {
                    id: (*e).to_owned(),
                    file: format!("pi-extensions/{e}.ts"),
                    description: None,
                })
                .collect(),
            ..Default::default()
        });
        m
    }

    fn enabled(rows: &[(&str, &[&str])]) -> HashMap<String, Vec<String>> {
        rows.iter()
            .map(|(id, grants)| {
                (
                    (*id).to_owned(),
                    grants.iter().map(|g| (*g).to_owned()).collect(),
                )
            })
            .collect()
    }

    /// Source resolver that always answers, so the tests below isolate the gate and
    /// the naming rules from I/O.
    fn always(_: &str, rel: &str) -> Result<String, String> {
        Ok(format!("// {rel}\n"))
    }

    #[test]
    fn a_community_plugin_without_the_grant_ships_nothing() {
        // `@example/x` is not in CORE_PLUGINS, so it is Community-tier.
        let manifests = [manifest("@example/x", &["shell"])];
        let resolution =
            resolve_pi_extensions(&manifests, &enabled(&[("@example/x", &[])]), always);
        assert!(resolution.extensions.is_empty());
        assert_eq!(resolution.skipped.len(), 1);
        assert!(resolution.skipped[0].reason.contains(GRANT_PI_EXTENSION));
    }

    #[test]
    fn the_approved_grant_opens_the_gate() {
        let manifests = [manifest("@example/x", &["shell"])];
        let resolution = resolve_pi_extensions(
            &manifests,
            &enabled(&[("@example/x", &[GRANT_PI_EXTENSION])]),
            always,
        );
        assert_eq!(resolution.extensions.len(), 1);
        assert_eq!(
            resolution.extensions[0].file_name,
            "ext-@example+x-shell.ts"
        );
    }

    /// The gate must read the APPROVED grants, never the manifest's own
    /// declarations — a manifest asking for a grant is not a grant.
    #[test]
    fn a_manifest_declaring_the_grant_does_not_grant_itself() {
        let mut m = manifest("@example/x", &["shell"]);
        m.permission_grants = vec![GRANT_PI_EXTENSION.to_owned()];
        let resolution = resolve_pi_extensions(&[m], &enabled(&[("@example/x", &[])]), always);
        assert!(resolution.extensions.is_empty());
    }

    #[test]
    fn a_disabled_plugin_contributes_nothing() {
        let manifests = [manifest("@example/x", &["shell"])];
        let resolution = resolve_pi_extensions(&manifests, &HashMap::new(), always);
        assert!(resolution.extensions.is_empty());
        assert!(resolution.skipped.is_empty());
    }

    /// Two plugins whose flattened names collide across the `-` boundary: the first
    /// by sort order wins and the loser is a visible skip, never a silent overwrite.
    #[test]
    fn a_file_name_collision_skips_the_loser() {
        let manifests = [manifest("a", &["b-c"]), manifest("a-b", &["c"])];
        let resolution = resolve_pi_extensions(
            &manifests,
            &enabled(&[("a", &[GRANT_PI_EXTENSION]), ("a-b", &[GRANT_PI_EXTENSION])]),
            always,
        );
        assert_eq!(resolution.extensions.len(), 1);
        assert_eq!(resolution.extensions[0].plugin_id, "a");
        assert_eq!(resolution.skipped.len(), 1);
        assert!(resolution.skipped[0].reason.contains("already owns"));
    }

    /// An unresolvable source is a skip with a reason, not a written empty file: an
    /// extension that loads with no body is indistinguishable at runtime from one
    /// that chose to register nothing.
    #[test]
    fn an_unresolvable_source_is_a_visible_skip() {
        let manifests = [manifest("@example/x", &["shell"])];
        let resolution = resolve_pi_extensions(
            &manifests,
            &enabled(&[("@example/x", &[GRANT_PI_EXTENSION])]),
            |_, _| Err("no such file".to_owned()),
        );
        assert!(resolution.extensions.is_empty());
        assert_eq!(resolution.skipped.len(), 1);
        assert!(resolution.skipped[0].reason.contains("no such file"));
    }

    /// The seam, end to end, over the REAL built-in manifests and the REAL
    /// [`read_source`] fork — no fixtures and no injected resolver.
    ///
    /// The bijection tests in `plugin_manifest` compare two lists; they never read a
    /// byte. This is the one that would catch a table-vs-disk ordering flip, an id
    /// canonicalization mismatch, or a file-name rule change: it asserts that the
    /// two first-party Pi extensions resolve to exactly the bytes
    /// `BUILTIN_PI_EXTENSIONS` embeds, under exactly the names
    /// [`super::sync_app_pi_extensions`] will write.
    #[test]
    fn the_first_party_extensions_resolve_from_the_embed_table() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let resolution = resolve_pi_extensions(
            &manifests,
            &enabled(&[
                ("@ryu/pi-shell", &[]),
                ("@ryu/pi-subagent", &[]),
                ("@ryu/pi-monitor", &[]),
                ("@ryu/pi-copy", &[]),
            ]),
            read_source,
        );
        assert!(
            resolution.skipped.is_empty(),
            "the first-party extensions must resolve cleanly: {:?}",
            resolution.skipped
        );

        let names: Vec<&str> = resolution
            .extensions
            .iter()
            .map(|e| e.file_name.as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                "ext-@ryu+pi-copy-copy.ts",
                "ext-@ryu+pi-monitor-monitor.ts",
                "ext-@ryu+pi-shell-shell.ts",
                "ext-@ryu+pi-subagent-subagent.ts"
            ]
        );

        for ext in &resolution.extensions {
            let embedded = crate::plugin_manifest::builtin_pi_extension(
                &ext.plugin_id,
                &format!("pi-extensions/ryu-{}.ts", ext.extension_id),
            )
            .expect("the extension is embedded");
            assert_eq!(
                ext.source,
                embedded,
                "{} resolved to something other than its embedded source",
                ext.key()
            );
        }
    }

    /// Every materialized name carries the ownership prefix — the invariant that
    /// keeps the reconciler from ever deleting a compiled-in `ryu-*.ts`.
    #[test]
    fn every_materialized_name_carries_the_ownership_prefix() {
        let manifests = [manifest("@example/x", &["a", "b"])];
        let resolution = resolve_pi_extensions(
            &manifests,
            &enabled(&[("@example/x", &[GRANT_PI_EXTENSION])]),
            always,
        );
        assert_eq!(resolution.extensions.len(), 2);
        for ext in &resolution.extensions {
            assert!(
                ext.file_name.starts_with(APP_EXTENSION_PREFIX),
                "{} is missing the ownership prefix",
                ext.file_name
            );
        }
    }
}
