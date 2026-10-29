//! Language-server resolution: enabled plugin manifests → one arbitrated table.
//!
//! A plugin declares language servers in `contributes.lsp_servers`
//! ([`LspServerContribution`]) — the agent-neutral mirror of Claude Code's
//! `.lsp.json` / `lspServers`. It ships CONFIG ONLY, never the server binary.
//! This module turns every enabled plugin's declarations into ONE resolved table
//! with Claude Code's semantics already applied, so the thing that finally spawns
//! `gopls` has no arbitration left to do:
//!
//! 1. a server with invalid config is **skipped** — the others still start, and
//!    the skipped one does NOT claim its extensions, so a sibling declaring the
//!    same extension gets it;
//! 2. **first registration wins per file extension** — a later server claiming an
//!    already-owned extension loses that extension and is told who owns it;
//! 3. a server left with zero extensions after (2) is dropped, because it would
//!    have been spawned to handle nothing.
//!
//! # Why the table is resolved HERE and not at the spawn site
//!
//! The binding for the flagship `ryu` agent is the `ryu-lsp.ts` Pi extension,
//! which re-applies rule (2) over whatever it is handed. Emitting the *unresolved*
//! union and letting it arbitrate would work, but it would make the JSON object's
//! key order load-bearing across a process boundary — and `serde_json::Map` is a
//! `BTreeMap` in this build, so Core cannot express an authoring order in the first
//! place. Resolving here makes the emitted document collision-free by construction
//! (see `emitted_document_has_no_duplicate_extension_claims`), which reduces the
//! extension's own pass to a no-op and removes the ordering coupling entirely.
//!
//! # Placement
//!
//! Agent-neutral on purpose: nothing here knows about Pi. The per-agent binding
//! (materialising this table where the managed Pi's extension reads it) lives in
//! [`crate::pi_config`], and a second agent would add a second binding, not a
//! second collector. This is also why the table is NOT served from
//! `GET /api/plugins/contributions`: that endpoint is the UI plane and applies a
//! `surface` filter, and a language server gated on which shell happened to poll
//! would be a bug — Core is the consumer here, not the desktop.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::pi_config::app_extensions::{may_ship_pi_extensions, GRANT_PI_EXTENSION};
use crate::plugin_manifest::{LspServerContribution, LspTransport, PluginManifest};
use crate::server::ServerState;

/// One language server that survived arbitration, ready to be spawned.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedLspServer {
    /// The plugin that declared it — carried so a skip/shadow message can name a
    /// culprit the user can actually act on (disable *that* plugin).
    pub plugin_id: String,
    /// The key the plugin filed it under inside `contributes.lsp_servers`.
    pub server_name: String,
    /// The declaration, with `extension_to_language` rewritten to the normalised
    /// extensions this server actually OWNS (shadowed ones removed). Every other
    /// field is the author's verbatim value.
    pub config: LspServerContribution,
}

impl ResolvedLspServer {
    /// The stable identity of this server across the node: `<plugin id>/<server
    /// name>`.
    ///
    /// Qualified unconditionally rather than only on collision. Two plugins may
    /// each file a server under `"go"`, and an unqualified key would silently
    /// collapse them into one JSON entry; qualifying only the loser would make a
    /// key change identity as unrelated plugins are installed, which is worse for
    /// anyone diffing the emitted file or reading a log line.
    pub fn key(&self) -> String {
        format!("{}/{}", self.plugin_id, self.server_name)
    }
}

/// One declaration that will NOT be started, and why — in words meant for a human.
///
/// Every drop produces one of these. Claude Code's contract is that a skip is
/// *visible*: silently discarding a server the user configured is the failure mode
/// this type exists to prevent.
#[derive(Debug, Clone, PartialEq)]
pub struct LspSkip {
    /// `<plugin id>/<server name>` — see [`ResolvedLspServer::key`].
    pub key: String,
    /// Human-facing reason, already naming the server (and the winner, for a
    /// first-registration-wins loss).
    pub reason: String,
}

/// The arbitrated table for a node: what will start, and what will not.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LspResolution {
    /// Servers to start, in `(plugin id ascending, server key ascending)` order.
    pub servers: Vec<ResolvedLspServer>,
    /// Every dropped declaration with its reason.
    pub skipped: Vec<LspSkip>,
}

impl LspResolution {
    /// No server will start. The binding treats this as "remove the materialised
    /// config", not "leave the last one in place" — see
    /// [`crate::pi_config::write_lsp_servers_file`].
    pub fn is_empty(&self) -> bool {
        self.servers.is_empty()
    }

    /// The wire document a per-agent binding materialises: the `{"servers": {…}}`
    /// wrapper, keyed by [`ResolvedLspServer::key`], with each value serialised
    /// from [`LspServerContribution`] — camelCase, field-for-field Claude Code.
    ///
    /// The wrapper form (rather than the bare `.lsp.json` map) is chosen so a
    /// reader takes `root.servers` and never has to guess which top-level keys are
    /// server declarations and which are metadata.
    ///
    /// Deliberately carries NO generation timestamp. The binding writes this file
    /// only when its bytes differ, and a stamp that changes every spawn would turn
    /// that content-compare into an unconditional write on every chat.
    pub fn to_wire_document(&self) -> serde_json::Value {
        let mut servers = serde_json::Map::new();
        for server in &self.servers {
            let Ok(value) = serde_json::to_value(&server.config) else {
                continue;
            };
            servers.insert(server.key(), value);
        }
        serde_json::json!({ "servers": serde_json::Value::Object(servers) })
    }
}

/// Arbitrate every enabled plugin's `contributes.lsp_servers` into one table.
///
/// Pure over `(manifests, enabled)` so the rules below are unit-testable without a
/// running server; [`resolve_for_node`] is the thin async wrapper that supplies
/// both from `ServerState`.
///
/// # The order the rules are applied in is part of the contract
///
/// `contributes.lsp_servers` is a `BTreeMap`, so servers within one manifest
/// iterate by key ascending — never hash order, never JSON authoring order. Across
/// manifests this sorts by plugin `id` ascending. That is a deliberate reading of
/// "plugin enable order": the manifest list Core holds is built from compiled-in
/// built-ins followed by `read_dir` over the plugins dir, and `read_dir` order is
/// not stable across machines, so relying on it would make two nodes with the
/// identical plugin set disagree about who owns `.go` — and print a different
/// warning naming a different owner. Sorting by `id` is the only total order
/// available here that every node computes the same way.
///
/// # What is NOT checked here
///
/// Whether `command` exists on `PATH`. That probe belongs to whatever finally
/// spawns the process, for two reasons: Core's environment is not necessarily the
/// spawned agent's, and — more importantly — a PATH miss must NOT release the
/// server's extension claim. Claude Code registers a server and then fails to
/// start it; handing `.go` to the next declarant because the user has not
/// installed `gopls` yet would mean installing a toolchain silently changes which
/// plugin owns the language.
pub fn resolve_lsp_servers(
    manifests: &[PluginManifest],
    enabled: &HashMap<String, Vec<String>>,
) -> LspResolution {
    let mut candidates: Vec<&PluginManifest> = manifests
        .iter()
        .filter(|m| enabled.contains_key(&m.id))
        .filter(|m| {
            m.contributes
                .as_ref()
                .is_some_and(|c| !c.lsp_servers.is_empty())
        })
        .collect();
    candidates.sort_by(|a, b| a.id.cmp(&b.id));

    let mut resolution = LspResolution::default();
    // Normalised extension → the key of the server that owns it.
    let mut owners: BTreeMap<String, String> = BTreeMap::new();

    for manifest in candidates {
        let Some(contributes) = manifest.contributes.as_ref() else {
            continue;
        };
        let grants = enabled.get(&manifest.id).map(Vec::as_slice).unwrap_or(&[]);
        let tier = crate::plugins::builtins::tier_for_manifest(manifest);
        if !may_ship_pi_extensions(tier, grants) {
            for (server_name, _) in &contributes.lsp_servers {
                resolution.skipped.push(LspSkip {
                    key: format!("{}/{}", manifest.id, server_name),
                    reason: format!(
                        "plugin '{}' is {tier:?}-tier and has no approved '{}' grant, so its +lsp server is not started (fail-closed)",
                        manifest.id,
                        GRANT_PI_EXTENSION,
                    ),
                });
            }
            continue;
        }
        for (server_name, decl) in &contributes.lsp_servers {
            let key = format!("{}/{server_name}", manifest.id);

            if let Err(reason) = decl.validate(server_name) {
                resolution.skipped.push(LspSkip { key, reason });
                continue;
            }
            // A SECOND gate, and not folded into `validate`: a `socket` server is
            // valid config that Core cannot drive (nothing in the field set carries
            // a host or port), so it parses, validates, and would then have nowhere
            // to connect. Refusing it here — before it claims anything — is what
            // keeps a stdio sibling declaring the same extension alive.
            if decl.transport_kind() != LspTransport::Stdio {
                resolution.skipped.push(LspSkip {
                    key,
                    reason: format!(
                        "lsp server '{server_name}' declares transport '{}', which is not supported (stdio only)",
                        decl.transport.trim()
                    ),
                });
                continue;
            }

            let mut owned: BTreeMap<String, String> = BTreeMap::new();
            for (ext, language) in decl.normalized_extensions() {
                match owners.get(&ext) {
                    Some(owner) => resolution.skipped.push(LspSkip {
                        key: key.clone(),
                        reason: format!(
                            "lsp server '{server_name}' will not handle '{ext}' — already claimed by '{owner}' (first registration wins)"
                        ),
                    }),
                    None => {
                        owners.insert(ext.clone(), key.clone());
                        owned.insert(ext, language);
                    }
                }
            }
            if owned.is_empty() {
                // Every extension it declared was already spoken for. Emitting it
                // anyway would spawn a language server that can never be asked
                // about a file — the per-extension warnings above already said who
                // won, so this line only reports the consequence.
                resolution.skipped.push(LspSkip {
                    key,
                    reason: format!(
                        "lsp server '{server_name}' handles no file extension of its own and will not start"
                    ),
                });
                continue;
            }

            // Clone-and-narrow rather than a struct literal: `LspServerContribution`
            // deliberately derives no `Default`, because a derived one would give
            // `restartOnCrash: false` / `diagnostics: false` and invert Claude Code
            // parity. Cloning carries the author's values through untouched.
            let mut config = decl.clone();
            config.extension_to_language = owned;
            resolution.servers.push(ResolvedLspServer {
                plugin_id: manifest.id.clone(),
                server_name: server_name.clone(),
                config,
            });
        }
    }

    resolution
}

/// [`resolve_lsp_servers`] over the node's live plugin set: the enabled lifecycle
/// records intersected with the in-memory manifest list.
///
/// Reads `app_manifests` (hot-updated in memory) rather than re-walking the
/// plugins dir, and drops the guard before arbitrating — the same shape as
/// [`crate::document_parse`]'s capability resolver, which is the closest existing
/// agent-plane lookup.
pub async fn resolve_for_node(state: &ServerState) -> LspResolution {
    let Ok(records) = state.app_store.list().await else {
        return LspResolution::default();
    };
    let mut enabled: HashMap<String, Vec<String>> = records
        .iter()
        .filter(|r| r.enabled)
        .map(|r| (r.id.clone(), r.approved_grants.clone()))
        .collect();

    // Filter before cloning: this runs on every managed-Pi spawn, and a node with
    // dozens of installed plugins would otherwise deep-clone every manifest to
    // read the handful that declare a language server.
    let manifests = state.app_manifests.read().await;
    let candidates: Vec<PluginManifest> = manifests
        .iter()
        .filter(|m| enabled.contains_key(&m.id))
        .filter(|m| {
            m.contributes
                .as_ref()
                .is_some_and(|c| !c.lsp_servers.is_empty())
        })
        .cloned()
        .collect();
    drop(manifests);

    // A language server is a spawned host process: a locally revoked plugin, or
    // one with no trust basis on a node that requires it, starts none.
    let mut refused = Vec::new();
    if !candidates.is_empty() {
        let policy = crate::plugins::isolation::load_trust_policy(Some(&state.app_store)).await;
        for manifest in &candidates {
            let record = records.iter().find(|r| r.id == manifest.id);
            let version = record.map_or(manifest.version.as_str(), |r| r.version.as_str());
            let provenance = record.and_then(|r| r.provenance.as_ref());
            let Some(refusal) = policy.host_access_refusal(manifest, version, provenance) else {
                continue;
            };
            enabled.remove(&manifest.id);
            for server_name in manifest
                .contributes
                .iter()
                .flat_map(|c| c.lsp_servers.keys())
            {
                refused.push(LspSkip {
                    key: format!("{}/{server_name}", manifest.id),
                    reason: format!("plugin '{}': {refusal}", manifest.id),
                });
            }
        }
    }

    let mut resolution = resolve_lsp_servers(&candidates, &enabled);
    resolution.skipped.extend(refused);
    resolution
}

/// Materialise the node's resolved table into the managed Pi's config dir, so the
/// next Pi spawn reads it.
///
/// Called from the ACP spawn path under its existing managed-Pi gate. Three
/// properties are load-bearing:
///
/// - **Fail-open.** No published `ServerState` (unit tests, any headless path that
///   never built a server) means no LSP materialisation — never a panic and never
///   a failed spawn. Every other borrower of `learning::global_state()` has the
///   same posture.
/// - **Best-effort.** A write failure warns and the agent starts without language
///   servers. LSP is an enhancement; it must not be able to take an agent down.
/// - **Read at process start, so written at process start.** Pi reads its
///   extensions and their config when it boots, and cannot be told about a new
///   language server mid-session. Enabling an LSP-contributing plugin therefore
///   takes effect on the NEXT Pi spawn for a chat, not the next turn — matching
///   Claude Code, where servers are likewise read at startup. Do not "fix" this by
///   moving the write into the per-turn loop: it would be pure disk churn, because
///   there is nothing to send a live Pi that would make it re-read.
pub async fn ensure_lsp_servers_materialized() {
    let Some(state) = crate::learning::global_state() else {
        return;
    };
    let resolution = resolve_for_node(&state).await;
    for skip in &resolution.skipped {
        tracing::warn!(target: "lsp", plugin = %skip.key, "{}", skip.reason);
    }
    if let Err(err) = crate::pi_config::write_lsp_servers_file(&resolution) {
        tracing::warn!(target: "lsp", "materialize language-server config: {err:#}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::Contributes;

    /// A minimal valid stdio declaration for `exts` (raw keys, normalised by the
    /// resolver). Built with a full struct literal because
    /// `LspServerContribution` has no `Default` on purpose.
    fn decl(command: &str, exts: &[(&str, &str)]) -> LspServerContribution {
        LspServerContribution {
            command: command.to_owned(),
            args: vec![],
            extension_to_language: exts
                .iter()
                .map(|(e, l)| ((*e).to_owned(), (*l).to_owned()))
                .collect(),
            transport: LspTransport::STDIO.to_owned(),
            env: BTreeMap::new(),
            initialization_options: None,
            settings: None,
            workspace_folder: None,
            startup_timeout: None,
            shutdown_timeout: None,
            restart_on_crash: true,
            max_restarts: None,
            diagnostics: true,
        }
    }

    fn manifest(id: &str, servers: &[(&str, LspServerContribution)]) -> PluginManifest {
        PluginManifest {
            id: id.to_owned(),
            name: id.to_owned(),
            contributes: Some(Contributes {
                lsp_servers: servers
                    .iter()
                    .map(|(name, decl)| ((*name).to_owned(), decl.clone()))
                    .collect(),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn enabled(ids: &[&str]) -> HashMap<String, Vec<String>> {
        ids.iter()
            .map(|id| ((*id).to_owned(), vec![GRANT_PI_EXTENSION.to_owned()]))
            .collect()
    }

    const SHIPPED_LSP_MANIFESTS: &[(&str, &str)] = &[
        (
            "clangd-lsp",
            include_str!("../../../generated/ryu-runtime/plugins-store/lsp/clangd-lsp/manifest.json"),
        ),
        (
            "csharp-lsp",
            include_str!("../../../generated/ryu-runtime/plugins-store/lsp/csharp-lsp/manifest.json"),
        ),
        (
            "gopls-lsp",
            include_str!("../../../generated/ryu-runtime/plugins-store/lsp/gopls-lsp/manifest.json"),
        ),
        (
            "jdtls-lsp",
            include_str!("../../../generated/ryu-runtime/plugins-store/lsp/jdtls-lsp/manifest.json"),
        ),
        (
            "kotlin-lsp",
            include_str!("../../../generated/ryu-runtime/plugins-store/lsp/kotlin-lsp/manifest.json"),
        ),
        (
            "lua-lsp",
            include_str!("../../../generated/ryu-runtime/plugins-store/lsp/lua-lsp/manifest.json"),
        ),
        (
            "php-lsp",
            include_str!("../../../generated/ryu-runtime/plugins-store/lsp/php-lsp/manifest.json"),
        ),
        (
            "pyright-lsp",
            include_str!("../../../generated/ryu-runtime/plugins-store/lsp/pyright-lsp/manifest.json"),
        ),
        (
            "ruby-lsp",
            include_str!("../../../generated/ryu-runtime/plugins-store/lsp/ruby-lsp/manifest.json"),
        ),
        (
            "rust-analyzer-lsp",
            include_str!("../../../generated/ryu-runtime/plugins-store/lsp/rust-analyzer-lsp/manifest.json"),
        ),
        (
            "swift-lsp",
            include_str!("../../../generated/ryu-runtime/plugins-store/lsp/swift-lsp/manifest.json"),
        ),
        (
            "typescript-lsp",
            include_str!("../../../generated/ryu-runtime/plugins-store/lsp/typescript-lsp/manifest.json"),
        ),
    ];

    fn shipped_lsp_manifests() -> Vec<PluginManifest> {
        SHIPPED_LSP_MANIFESTS
            .iter()
            .map(|(package, raw)| {
                let manifest: PluginManifest =
                    serde_json::from_str(raw).expect("shipped LSP manifest parses");
                assert_eq!(manifest.id, format!("@ryu/{package}"));
                manifest
            })
            .collect()
    }

    #[test]
    fn resolves_a_single_declaration_and_normalizes_extension_keys() {
        let manifests = vec![manifest(
            "com.example.go",
            &[("go", decl("gopls", &[("GO", "go"), (".mod", "go.mod")]))],
        )];
        let resolution = resolve_lsp_servers(&manifests, &enabled(&["com.example.go"]));

        assert!(resolution.skipped.is_empty(), "{:?}", resolution.skipped);
        assert_eq!(resolution.servers.len(), 1);
        let server = &resolution.servers[0];
        assert_eq!(server.key(), "com.example.go/go");
        assert_eq!(
            server
                .config
                .extension_to_language
                .keys()
                .collect::<Vec<_>>(),
            vec![".go", ".mod"],
            "bare and upper-case keys are normalised to `.ext`"
        );
    }

    #[test]
    fn disabled_plugins_contribute_nothing() {
        let manifests = vec![manifest(
            "com.example.go",
            &[("go", decl("gopls", &[(".go", "go")]))],
        )];
        let resolution = resolve_lsp_servers(&manifests, &enabled(&[]));

        assert!(resolution.is_empty());
        assert!(
            resolution.skipped.is_empty(),
            "a disabled plugin is not a skip — it never entered the table"
        );
    }

    #[test]
    fn invalid_declarations_are_skipped_without_claiming_their_extensions() {
        // `broken` has no command, so `.go` must fall through to `good` even though
        // `broken` is declared by the alphabetically FIRST plugin.
        let mut no_command = decl("gopls", &[(".go", "go")]);
        no_command.command = String::new();
        let mut no_extensions = decl("gopls", &[]);
        no_extensions.extension_to_language.clear();

        let manifests = vec![
            manifest(
                "com.example.a-broken",
                &[("empty", no_extensions), ("go", no_command)],
            ),
            manifest(
                "com.example.b-good",
                &[("go", decl("gopls", &[(".go", "go")]))],
            ),
        ];
        let resolution = resolve_lsp_servers(
            &manifests,
            &enabled(&["com.example.a-broken", "com.example.b-good"]),
        );

        assert_eq!(resolution.servers.len(), 1);
        assert_eq!(resolution.servers[0].key(), "com.example.b-good/go");
        assert_eq!(resolution.skipped.len(), 2, "{:?}", resolution.skipped);
        assert!(
            resolution
                .skipped
                .iter()
                .any(|s| s.key == "com.example.a-broken/go" && s.reason.contains("'command'")),
            "the missing-command skip names the reason: {:?}",
            resolution.skipped
        );
    }

    #[test]
    fn first_registration_wins_per_extension_and_names_the_owner() {
        let manifests = vec![
            manifest("com.example.a", &[("go", decl("gopls", &[(".go", "go")]))]),
            manifest(
                "com.example.b",
                &[(
                    "go",
                    decl("other-gopls", &[(".go", "go"), (".gohtml", "gotmpl")]),
                )],
            ),
        ];
        let resolution =
            resolve_lsp_servers(&manifests, &enabled(&["com.example.a", "com.example.b"]));

        // The loser keeps the extension nobody else claimed, and loses only `.go`.
        assert_eq!(resolution.servers.len(), 2);
        assert_eq!(
            resolution.servers[1]
                .config
                .extension_to_language
                .keys()
                .collect::<Vec<_>>(),
            vec![".gohtml"]
        );
        assert!(
            resolution
                .skipped
                .iter()
                .any(|s| s.reason.contains(".go") && s.reason.contains("com.example.a/go")),
            "the warning names the winning server: {:?}",
            resolution.skipped
        );
    }

    #[test]
    fn a_fully_shadowed_server_is_dropped_rather_than_started_for_nothing() {
        let manifests = vec![
            manifest("com.example.a", &[("go", decl("gopls", &[(".go", "go")]))]),
            manifest("com.example.b", &[("go", decl("gopls", &[("go", "go")]))]),
        ];
        let resolution =
            resolve_lsp_servers(&manifests, &enabled(&["com.example.a", "com.example.b"]));

        assert_eq!(resolution.servers.len(), 1);
        assert_eq!(resolution.servers[0].key(), "com.example.a/go");
        assert!(
            resolution
                .skipped
                .iter()
                .any(|s| s.key == "com.example.b/go" && s.reason.contains("will not start")),
            "{:?}",
            resolution.skipped
        );
    }

    #[test]
    fn a_socket_server_is_skipped_and_does_not_steal_the_extension() {
        let mut socket = decl("gopls", &[(".go", "go")]);
        socket.transport = "socket".to_owned();
        let manifests = vec![
            manifest("com.example.a-socket", &[("go", socket)]),
            manifest(
                "com.example.b-stdio",
                &[("go", decl("gopls", &[(".go", "go")]))],
            ),
        ];
        let resolution = resolve_lsp_servers(
            &manifests,
            &enabled(&["com.example.a-socket", "com.example.b-stdio"]),
        );

        assert_eq!(resolution.servers.len(), 1);
        assert_eq!(resolution.servers[0].key(), "com.example.b-stdio/go");
        assert!(
            resolution
                .skipped
                .iter()
                .any(|s| s.key == "com.example.a-socket/go" && s.reason.contains("socket")),
            "{:?}",
            resolution.skipped
        );
    }

    #[test]
    fn resolution_is_independent_of_manifest_list_order() {
        let a = manifest("com.example.a", &[("go", decl("gopls", &[(".go", "go")]))]);
        let b = manifest("com.example.b", &[("go", decl("gopls", &[(".go", "go")]))]);
        let ids = enabled(&["com.example.a", "com.example.b"]);

        // `read_dir` order is not stable across machines; the resolver must be.
        let forward = resolve_lsp_servers(&[a.clone(), b.clone()], &ids);
        let reverse = resolve_lsp_servers(&[b, a], &ids);
        assert_eq!(forward, reverse);
    }

    #[test]
    fn emitted_document_has_no_duplicate_extension_claims() {
        // This is what licenses the emitted JSON object's key order to be
        // irrelevant: Core has already arbitrated, so the reader's own
        // first-registration-wins pass can never fire.
        let manifests = vec![
            manifest(
                "com.example.a",
                &[("go", decl("gopls", &[(".go", "go"), (".mod", "gomod")]))],
            ),
            manifest(
                "com.example.b",
                &[("go", decl("gopls2", &[("GO", "go"), (".ts", "typescript")]))],
            ),
        ];
        let resolution =
            resolve_lsp_servers(&manifests, &enabled(&["com.example.a", "com.example.b"]));

        let doc = resolution.to_wire_document();
        let servers = doc
            .get("servers")
            .and_then(serde_json::Value::as_object)
            .expect("wrapper carries a servers object");
        let mut seen: HashSet<String> = HashSet::new();
        for value in servers.values() {
            let map = value
                .get("extensionToLanguage")
                .and_then(serde_json::Value::as_object)
                .expect("every emitted server carries extensionToLanguage");
            for ext in map.keys() {
                assert!(seen.insert(ext.clone()), "'{ext}' claimed twice in {doc}");
            }
        }
        assert_eq!(seen.len(), 3);
    }

    #[test]
    fn wire_document_uses_claude_code_camel_case_spelling() {
        let mut server = decl("gopls", &[(".go", "go")]);
        server.args = vec!["serve".to_owned()];
        server.startup_timeout = Some(20_000);
        server.diagnostics = false;
        let manifests = vec![manifest("com.example.go", &[("go", server)])];
        let resolution = resolve_lsp_servers(&manifests, &enabled(&["com.example.go"]));

        let doc = resolution.to_wire_document();
        let entry = &doc["servers"]["com.example.go/go"];
        assert_eq!(entry["command"], "gopls");
        assert_eq!(entry["args"][0], "serve");
        assert_eq!(entry["extensionToLanguage"][".go"], "go");
        assert_eq!(entry["startupTimeout"], 20_000);
        assert_eq!(entry["restartOnCrash"], true);
        assert_eq!(
            entry["diagnostics"], false,
            "an explicit false must survive the round trip, not be defaulted back on"
        );
        assert!(
            doc.get("generatedAt").is_none(),
            "no timestamp: it would defeat the binding's content-compare write"
        );
    }

    #[test]
    fn shipped_lsp_manifests_resolve_to_exact_local_wire_configs() {
        let manifests = shipped_lsp_manifests();
        assert_eq!(manifests.len(), 12);
        let enabled: HashMap<String, Vec<String>> = manifests
            .iter()
            .map(|manifest| (manifest.id.clone(), manifest.permission_grants.clone()))
            .collect();

        let resolution = resolve_lsp_servers(&manifests, &enabled);
        assert!(resolution.skipped.is_empty(), "{:?}", resolution.skipped);
        let expected_count = manifests
            .iter()
            .map(|manifest| {
                manifest
                    .contributes
                    .as_ref()
                    .expect("shipped LSP package contributes servers")
                    .lsp_servers
                    .len()
            })
            .sum::<usize>();
        assert_eq!(resolution.servers.len(), expected_count);

        let wire = resolution.to_wire_document();
        let wire_servers = wire["servers"]
            .as_object()
            .expect("wire document has a servers object");
        let mut owned_extensions = HashSet::new();
        for manifest in &manifests {
            let declarations = &manifest.contributes.as_ref().unwrap().lsp_servers;
            for (server_name, declaration) in declarations {
                assert_eq!(declaration.validate(server_name), Ok(()));
                let key = format!("{}/{server_name}", manifest.id);
                let resolved = resolution
                    .servers
                    .iter()
                    .find(|server| server.key() == key)
                    .unwrap_or_else(|| panic!("{key} was not resolved"));

                // The host materializes each plugin's command and argv as a
                // stdio process config. No shell string or server process is
                // constructed by this resolver.
                assert_eq!(resolved.config.command, declaration.command);
                assert_eq!(resolved.config.args, declaration.args);
                assert_eq!(resolved.config.transport_kind(), LspTransport::Stdio);
                assert_eq!(
                    resolved.config.extension_to_language,
                    declaration.normalized_extensions()
                );
                for extension in resolved.config.extension_to_language.keys() {
                    assert!(
                        owned_extensions.insert(extension.clone()),
                        "duplicate shipped extension claim for {extension}"
                    );
                }

                let wire_config = &wire_servers[&key];
                assert_eq!(wire_config["command"], declaration.command);
                if declaration.args.is_empty() {
                    assert!(wire_config.get("args").is_none());
                } else {
                    assert_eq!(wire_config["args"], serde_json::json!(declaration.args));
                }
                assert_eq!(
                    wire_config["extensionToLanguage"],
                    serde_json::to_value(declaration.normalized_extensions()).unwrap()
                );
            }
        }
    }

    #[test]
    fn community_lsp_config_requires_an_approved_pi_extension_grant() {
        let mut manifest = shipped_lsp_manifests().remove(0);
        manifest.id = "@fixture/community-clangd".to_owned();
        let server_id = manifest.id.clone();
        let denied = HashMap::from([(server_id.clone(), Vec::new())]);
        let blocked = resolve_lsp_servers(&[manifest.clone()], &denied);
        assert!(blocked.servers.is_empty());
        assert_eq!(blocked.skipped.len(), 1);
        assert!(blocked.skipped[0].reason.contains(GRANT_PI_EXTENSION));

        let approved = HashMap::from([(server_id, vec![GRANT_PI_EXTENSION.to_owned()])]);
        let allowed = resolve_lsp_servers(&[manifest], &approved);
        assert_eq!(allowed.servers.len(), 1);
        assert!(allowed.skipped.is_empty());
    }
}
