//! **App manifest** — the `ryu.json` bundle descriptor for an installable Ryu App.
//!
//! # Scope (M3: type + parse + loader + list endpoint)
//!
//! This module defines the [`PluginManifest`] type, supports serde deserialisation of
//! a `ryu.json` file, and provides [`PluginManifestLoader`] — a scanner that reads
//! `~/.ryu/apps/*/ryu.json` (env-overridable via `RYU_APPS_DIR`), validates semver,
//! rejects duplicate ids, and merges built-in manifests with user-installed ones.
//! There is **no install/enable lifecycle here** — that lands in M3's install units.
//! There is **no permission-grant enforcement here** — grant enforcement belongs to
//! the Gateway (the Gateway decides what is *allowed*; Core decides what *runs*).
//!
//! # Distinction from the sidecar version catalog
//!
//! [`crate::catalog`] is the *sidecar version catalog*: it tracks what binary
//! versions of sidecars (providers, tools, agents) are available for download and
//! installation into `~/.ryu/bin`. It is an internal infrastructure concept.
//!
//! An [`PluginManifest`] is a *user-facing bundle descriptor* — a `ryu.json` file that
//! ships with (or describes) a Ryu App: it names the Runnables the app bundles, the
//! permission grants it needs, and an optional Companion surface. The two concepts
//! are deliberately kept separate and carry distinct names.
//!
//! # Per-kind config and validation
//!
//! Each Runnable entry in a manifest carries a `kind` discriminant
//! ([`crate::runnable::RunnableKind`]) and an optional typed `config` blob.
//! The per-kind config structs and the [`schema::validate_runnable`] function
//! live in the [`schema`] submodule; [`PluginManifestLoader`] runs validation during
//! loading and rejects any manifest whose Runnables fail their per-kind contract.

pub mod agent_plugin;
mod builtin_code;
pub(crate) use builtin_code::builtin_pi_extension_sources;
mod builtin_plugin_assets;
pub mod schema;
#[cfg(test)]
#[path = "shipped_portable_loader_runtime_test.rs"]
mod shipped_portable_loader_runtime;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use schema::validate_runnable;

// The `manifest.json` data model + validation (PluginManifest, Surface, Requires,
// the per-kind schema types, validate_plugin_id, parse_min_version, …) now has a
// single definition in the `ryu-kernel-contracts` crate. Re-export the whole
// surface so every `crate::plugin_manifest::<Type>` call site (hundreds of them)
// resolves unchanged. Only Core-specific, I/O-bearing pieces stay below: the
// `PluginManifestLoader`, `core_version`, the built-in fixtures, and UI consts.
pub use ryu_kernel_contracts::manifest::*;

/// Read a package-owned file after resolving symlinks and proving the resolved
/// target remains inside the package root. Lexical allowlists reject `..`, but a
/// symlink at an allowed path can still point anywhere on the author or node host.
pub(crate) fn read_contained_package_file(base: &Path, rel: &str) -> Result<String, String> {
    let canonical_base = std::fs::canonicalize(base)
        .map_err(|e| format!("{}: cannot resolve package root: {e}", base.display()))?;
    let joined = base.join(rel);
    let canonical_target =
        std::fs::canonicalize(&joined).map_err(|e| format!("{}: {e}", joined.display()))?;
    if !canonical_target.starts_with(&canonical_base) {
        return Err(format!(
            "{}: resolved target '{}' escapes package root '{}'",
            joined.display(),
            canonical_target.display(),
            canonical_base.display()
        ));
    }
    std::fs::read_to_string(&canonical_target)
        .map_err(|e| format!("{}: {e}", canonical_target.display()))
}

/// Resolve every path a manifest references into its inline wire form — `code_file`
/// → `code` and `output_styles[].file` → `source` — from the one source that can
/// actually hold the file for this manifest's provenance.
///
/// Two provenances, two sources, and the fork is not cosmetic:
///
/// - **`code_base: None` — a Core system plugin.** Its package directory does not
///   exist on the user's machine, so the small system-only code table supplies any
///   required bodies. Marketplace packages always use the on-disk branch.
/// - **`code_base: Some(dir)` — a manifest read off disk** (`~/.ryu/plugins/<id>/`,
///   a satellite checkout, a dev tree). Its files are right there next to it, so
///   they are read directly. [`validate_code_file_path`] /
///   [`validate_output_style_path`] constrain the lexical path, and
///   [`read_contained_package_file`] additionally rejects symlinks whose resolved
///   target escapes the plugin directory.
///
/// # Why both carriage paths run from ONE function
///
/// Not for brevity — for coverage. This is the single seam every manifest reaches
/// Core through (the loader below, `plugin_host`'s disk read, and `self_build`'s two
/// call sites), so a second sibling function would have to be threaded through all
/// four, and the one that got missed would leave a third-party plugin's styles
/// un-hydrated: `source` empty, `file` still set, and no error anywhere — the plugin
/// installs, enables, and contributes nothing.
pub fn hydrate_manifest_code_files(
    manifest: &mut PluginManifest,
    code_base: Option<&Path>,
) -> Result<(), String> {
    let plugin_id = manifest.id.clone();
    manifest.hydrate_code_files(|rel| match code_base {
        Some(dir) => read_contained_package_file(dir, rel),
        None => builtin_code::lookup(&plugin_id, rel)
            .map(str::to_owned)
            .ok_or_else(|| {
                format!(
                "built-in plugin '{plugin_id}' references '{rel}', which is not embedded — add \
                 an include_str! row for it to plugin_manifest::builtin_code::BUILTIN_CODE_FILES"
            )
            }),
    })?;
    manifest.hydrate_output_style_files(|rel| match code_base {
        Some(dir) => read_contained_package_file(dir, rel),
        None => builtin_code::lookup_output_style(&plugin_id, rel)
            .map(str::to_owned)
            .ok_or_else(|| {
                format!(
                    "built-in plugin '{plugin_id}' contributes output style file '{rel}', which \
                     is not embedded — add an include_str! row for it to \
                     plugin_manifest::builtin_code::BUILTIN_OUTPUT_STYLES"
                )
            }),
    })
}

/// Parse a manifest read from a package directory on disk, hydrate it through
/// [`hydrate_manifest_code_files`], then run the full validation gate.
///
/// The on-disk twin of [`PluginManifest::parse_and_validate_with_code`] for callers
/// holding a package directory. Hand-rolling that call with a bare
/// `dir.join(rel)` resolver skips both the symlink containment of
/// [`read_contained_package_file`] (an `adapters/x.js` symlink would copy any
/// host file into the persisted manifest) and output-style hydration (a styled
/// package then fails validation on its residual `file`).
pub(crate) fn parse_package_manifest(
    raw: &str,
    package_dir: &Path,
) -> Result<PluginManifest, String> {
    let mut manifest: PluginManifest =
        serde_json::from_str(raw).map_err(|e| format!("JSON parse error: {e}"))?;
    hydrate_manifest_code_files(&mut manifest, Some(package_dir))?;
    manifest.validate()?;
    Ok(manifest)
}

/// The compiled-in source of a built-in plugin's `contributes.pi_extensions[].file`,
/// or `None` when nothing embeds that path.
///
/// The pi-extension half of [`hydrate_manifest_code_files`]'s built-in branch,
/// exposed as a lookup rather than a hydration step: a Pi extension is a file the
/// agent opens by path, so its bytes are needed exactly once, at the materializer
/// (`pi_config::app_extensions`), and never inside the manifest. See
/// [`PluginManifest::pi_extension_refs`] for why that asymmetry is deliberate.
pub fn builtin_pi_extension(plugin_id: &str, rel: &str) -> Option<&'static str> {
    builtin_code::lookup_pi_extension(plugin_id, rel)
}

/// The running Core version, as a parsed [`semver::Version`]. Authoritative
/// source for the `engines.ryu` version-pin gate. Derived from the crate version
/// (`CARGO_PKG_VERSION`), which is the single version of record for Core.
pub fn core_version() -> semver::Version {
    // `CARGO_PKG_VERSION` is always valid semver (Cargo enforces it), so this
    // parse never fails in practice; fall back to 0.0.0 defensively.
    semver::Version::parse(env!("CARGO_PKG_VERSION"))
        .unwrap_or_else(|_| semver::Version::new(0, 0, 0))
}

/// File names a plugin manifest may use on disk, in preference order. The new
/// canonical name is `manifest.json`; the previous `plugin.json` and the legacy
/// `ryu.json` are still read so that plugins installed before the rename keep
/// loading. First match wins, so a directory carrying both resolves to
/// `manifest.json`.
///
/// Shared with [`crate::runnable::self_build`] so there is exactly ONE copy of
/// this ordering inside Core.
pub(crate) const MANIFEST_FILE_NAMES: &[&str] = &["manifest.json", "plugin.json", "ryu.json"];

/// Resolve the **native** manifest in a plugin directory, skipping an Agent
/// Plugins spec `plugin.json`.
///
/// `plugin.json` is both the spec's manifest name (§5.1) and a legacy alias for
/// our own, so a plain first-match over [`MANIFEST_FILE_NAMES`] can hand a spec
/// file to a native `serde_json::from_str::<PluginManifest>` — which fails for
/// having no `id`/`runnables`. Every caller that wants a NATIVE manifest and does
/// not go through [`PluginManifestLoader::translate_agent_plugin`] must use this
/// instead of re-spelling the ordering.
///
/// The loader's own directory scan deliberately does NOT use this: it wants the
/// first match either way, and translates a spec file into native form.
#[must_use]
pub fn resolve_native_manifest_path(dir: &Path) -> Option<PathBuf> {
    MANIFEST_FILE_NAMES
        .iter()
        .map(|name| dir.join(name))
        .find(|candidate| {
            if !candidate.exists() {
                return false;
            }
            // Unreadable or unparseable: hand it back so the caller reports the
            // real error against this path rather than silently skipping it.
            std::fs::read_to_string(candidate)
                .map_or(true, |raw| !agent_plugin::is_agent_plugin_manifest(&raw))
        })
}

/// The canonical manifest file name — the ONE name every write/scaffold path
/// emits. Reads accept the legacy names via [`MANIFEST_FILE_NAMES`]; writes must
/// never re-introduce them, or the migration never completes.
pub const MANIFEST_FILE_NAME: &str = MANIFEST_FILE_NAMES[0];

/// Built-in plugin manifests compiled into the binary, always present regardless of
/// whether the user has a `~/.ryu/plugins/` directory.
///
/// (`sample.manifest.json` — the Research Assistant demo — is kept as a test-only
/// fixture and is deliberately NOT shipped as a built-in.)
/// - `spider.manifest.json` — Spider web crawler tool. A fully declarative
///   `command` plugin (Core-tier, pre-installed): its single runnable IS the crawl
///   tool, backed by a BYO `spider` CLI reached through the command-tool
///   allowlist. The native `sidecar/mcp/spider.rs` provider was deleted, so the
///   fixture is the SOLE owner of the tool (see the exception note below).
/// - `ripgrep.manifest.json` — the exact local-search sibling of `spider` and
///   `rtk`: two fixed `command` tools backed by the BYO `rg` binary, with no
///   bundled MCP server or Core Rust provider. Its arguments are paths and
///   regular expressions only; the command tool passes them as an argv array.
/// - `scrapling.manifest.json` — Scrapling adaptive page extraction (BYO local
///   install, no API key). The THIRD `web.extract` provider, `selectable` and
///   claiming no `default` (`spider` keeps it). Three things about it are
///   deliberate and each is silent if reverted:
///   1. It is **MCP-backed with empty `runnables`** — its tools come from
///      `scrapling mcp`, so the verb binds `web.extract` to `scrapling.get`
///      exactly as `agentbrowser` binds `browser.*`. Capability providers are not
///      required to be manifest runnables; nothing in `resolve_verbs` reads them.
///   2. It is **Core-tier but NOT in `CORE_PREINSTALLED`**. Core-tier is a
///      requirement, not a promotion: `may_register_mcp_servers` auto-allows
///      manifest `mcp_servers` for Core-tier packages, while a Community-tier
///      plugin needs the approved `mcp:server` grant — off the Gateway's default
///      allowlist and in a reserved namespace, so operator-only. A Community-tier
///      Scrapling would register nothing and be dead on arrival. It stays opt-in
///      because it needs a `pip install "scrapling[ai]"` the user must perform,
///      the same reason the BYOK search providers are opt-in.
///   3. It maps the verb through an **adapter, not a `response` map**, for two
///      shape facts verified against a live server rather than the docs: an MCP
///      `tools/call` answer is the transport envelope (`{content, structuredContent,
///      isError}`), and `ResponseModel.content` is an ARRAY of chunks with empty
///      entries. The canonical `content` is a string and `map_item` copies a located
///      value verbatim — it has no join — so the flattening lives in the one provider
///      whose quirk it is, exactly as `firecrawl` collapses its `metadata.title`
///      array. The adapter also passes an `isError`/untyped answer through under
///      `raw`, which is what keeps a broken install visible: Scrapling declares
///      `mcp>=1.27.0` unbounded and `mcp` 2.x renamed `mcp.server.fastmcp`, so
///      `scrapling mcp` crashing on import is reachable, not hypothetical.
///   It deliberately does NOT provide `web.crawl`: only Scrapling's Python `Spider`
///   class follows links and MCP does not expose it (the `bulk_*` tools fetch a URL
///   list you already have). Same reasoning as `firecrawl`'s absent crawl entry — a
///   partial `tools` map would join resolution and could win the pick away from
///   `spider`, silently killing a layer that works. Absent, not empty.
/// - `zvec-grep.manifest.json` — zvec-grep's local-first hybrid workspace search.
///   It is an opt-in Core-tier MCP plugin whose pinned `npx` stdio bridge starts
///   or reuses the upstream daemon and exposes its default indexed-search tool.
/// - `agentbrowser.manifest.json` — Agent Browser web-browsing tool (system plugin, npx MCP-backed).
/// - `exa.manifest.json` — Exa neural search tool plugin (U040, BYOK). Provides the
///   selectable `web.search` capability and is its declared default.
/// - `layers.manifest.json` — settings for the swappable capability layers. Owns the
///   `layer.<capability>.default.<arg>` preferences the capability tool facade merges
///   under every verb call. Deliberately NOT attached to any one provider: the
///   defaults apply whichever provider is selected, so hanging them off `exa` would
///   make them vanish the moment the user swapped to `tavily`.
/// - `tavily.manifest.json` — Tavily search+extract tool plugin (BYOK). The second
///   provider of `web.search`, which is what makes the layer demonstrably swappable:
///   selecting it re-points the stable `web.search` tool without changing the id or
///   schema an agent sees.
/// - `brave.manifest.json` — Brave Search tool plugin (BYOK). A third `web.search`
///   provider, and the one that proves the capability SPLIT was right: Brave's API is
///   search-only, so it declares `web.search` and neither `web.extract` nor
///   `web.crawl`. Its single tool is a GET whose arguments become query parameters,
///   so the verb binding renames the canonical `query`/`limit` onto Brave's real
///   query params `q`/`count`.
/// - `serper.manifest.json` — Serper Google-results tool plugin (BYOK, paid/credit-metered).
///   A `web.search` provider whose value is that the results are Google's own, and a
///   `web.extract` provider through a SEPARATE host: search is `POST
///   google.serper.dev/search`, scraping is `POST scrape.serper.dev` with no path at
///   all, so the manifest carries two egress grants rather than one. Neither of
///   Serper's argument names is canonical — the query is `q` and the result count is
///   `num` — so both are renamed in the verb binding. The extract binding declares
///   `response.fields` but NO `results` path on purpose: a scrape answers with a
///   single record (`text` / `markdown`), not an array, which the contract reads as
///   "the response itself is the record".
/// - `parallel.manifest.json` — Parallel search+extract tool plugin (optional BYOK,
///   with anonymous search). An additional `web.search` provider, and the second
///   shipped provider after `exa` that works with no credential: Parallel publishes a
///   public Search MCP endpoint
///   (`search.parallel.ai/mcp`) alongside the keyed REST API, so the manifest
///   carries two egress grants and the verb goes through an ADAPTER that falls
///   back keyed → keyless, exactly as `exa` does. Unlike exa's, that endpoint is
///   stateless plain JSON-RPC — no `initialize`, no session, no SSE and no
///   `Accept` header — so the adapter reads `result.structuredContent` instead of
///   parsing an event-stream frame. Three further things force the adapter:
///   Parallel search takes an `objective` AND `search_queries`, so ONE canonical
///   `query` has to fan out to two args; its request bodies are
///   `additionalProperties: false` and expose NO result-count knob, so `limit` is
///   applied client-side; and each result's `excerpts` is an ARRAY of markdown
///   blocks where the canonical `snippet` is a string. `web.extract` needs none of
///   that and binds declaratively, asking for `advanced_settings.full_content` so
///   the per-URL record carries one markdown string.
/// - `deepseek.manifest.json` — DeepSeek Search / Fetch tool plugin (BYOK, billed per
///   successful request). A `web.search` and `web.extract` provider on ONE host
///   (`api.deepseek.com/v1/tools/{search,fetch}`), both bound declaratively: search
///   renames `limit` → `count` and maps the model-readable `summary` onto the
///   canonical `snippet`; fetch drops `format` (always markdown) and, like Serper's
///   scrape, declares no `results` path because it answers with one `{title,
///   content}` record. Its key is `RYU_DEEPSEEK_API_KEY`, deliberately not the model
///   provider's `DEEPSEEK_API_KEY`, so configuring chat models never turns on a
///   billed search layer.
/// - `ghost.manifest.json` — Ghost desktop-automation MCP tool (system plugin, cross-platform).
/// - `shadow.manifest.json` — Shadow screen/audio capture + semantic memory (system plugin, cross-platform).
///
/// The two sidecar-backed system tools (`agentbrowser`, `ghost`) declare an
/// **empty** `runnables` list on purpose: their tools are owned by the stdio MCP
/// server each declares under `mcp_servers` in its own fixture (`ghost` → the
/// `~/.ryu/bin/ghost mcp` binary; `agentbrowser` → `npx -y agentbrowser`),
/// registered into the MCP registry on activation by
/// `sidecar/mcp/register_manifest_mcp_servers` (they moved off the former
/// hardcoded `sidecar/mcp/mod.rs::builtin_servers`). `scrapling` shares that
/// empty-runnables shape for the same reason — its tools come from `scrapling mcp` —
/// but it is NOT a system plugin: there is no sidecar and no Core-managed process,
/// only a BYO binary Core launches on demand. The plugin record is the
/// install/enable/tier **governance shell** around that provider; declaring the
/// tools again here would double-list every one as an `app.<slug>` alias
/// (`fire_activation_event` → the Tool handler in `server/mod.rs`). Do not
/// re-add tool runnables to these fixtures.
///
/// EXCEPTION: `spider`, `rtk`, `ripgrep`, `advisor` and `shadow` CARRY their tool runnables,
/// because their Rust providers were deleted — the fixture is the only owner, so
/// there is nothing to double-list. The "no runnables" rule above exists solely to
/// avoid double-listing a provider-owned tool; it does not apply once the provider
/// is gone. `spider`/`rtk`/`ripgrep` are declarative `command`-backend tools; `advisor`
/// (`advisor.consult`) and `shadow` (`shadow.search`/`semantic_search`/`timeline`/
/// `recent_context`) are declarative `http`-backend tools reaching Core loopback
/// bridges (`/api/advisor/consult` and the `/api/shadow/*` proxy). `spider`/`rtk`
/// are reached through the
/// command-tool allowlist.
/// - `headroom.manifest.json` — Headroom gateway egress compression (a `compression` Policy runnable, #425).
/// - `firewall.manifest.json` — Gateway firewall on/off Policy plugin (#447, Core-tier, opt-in).
/// - `routing.manifest.json` — Smart (classifier) routing on/off Policy plugin (#447, Core-tier, opt-in).
/// - `sandbox.manifest.json` — Wasmtime ephemeral sandbox on/off Policy plugin (#448, Core-tier, opt-in).
/// - `engines.manifest.json` — Local engine bindings (llama.cpp + embeddings) as a pre-installed Core plugin (#448).
/// - `durable.manifest.json` — Durable workflow execution engine as a pre-installed Core plugin (#448 dogfood).
/// - `predict.manifest.json` — System-wide predictive typing on/off (a `predict` Policy runnable; Core-tier, opt-in). The plugin is the single switch for the `/api/predict/*` brain.
/// - `firecrawl.manifest.json` — Firecrawl search+scrape tool plugin (BYOK, v2 API).
///   A third provider of `web.search` and `web.extract`, claiming `default` on
///   neither (`exa` owns the former, `spider` the latter). It deliberately does NOT
///   provide `web.crawl`, even though Firecrawl has a crawl endpoint: `POST
///   /v2/crawl` is ASYNCHRONOUS — it answers `{success, id, url}` and the pages only
///   arrive from a second `GET /v2/crawl/{id}` poll. A declarative `http` tool is one
///   request with no polling loop, so binding `web.crawl` to it would hand the model
///   a job id where the verb promises page content. Declaring the capability with a
///   partial `tools` map would be worse still: the entry would join resolution for
///   `web.crawl` and could win the pick away from `spider`, silently killing a layer
///   that currently works. Hence the entry is absent rather than empty.
/// - `mem0.manifest.json` — Mem0 hosted memory tool plugin (BYOK, Platform REST API).
///   The SECOND provider of the `memory` capability, and the one that makes that layer
///   swappable at all — until it shipped, `@ryu/memory` was the only provider, so
///   `memory_provider.rs`'s four kernel bridges (each guarded by `if !is_external()`)
///   were unreachable by construction. It is `selectable` and claims NO `default`:
///   `@ryu/memory` keeps that, so the built-in stays the zero-config pick.
///   It binds `memory.search`, `memory.forget`, `memory.store` and `memory.sync`.
///   The two WRITE verbs became bindable only with `CapabilityToolBinding.arg_template`:
///   Mem0's write endpoint is `POST /v3/memories/add/`, whose `messages` field is an
///   array of `{role, content}` OBJECTS, and the flat rename table's one shape
///   transform — the `[]` suffix — produces an array of the SCALAR it was given,
///   i.e. `["fact"]`, which is not the documented item type. The template builds the
///   documented shape directly, so `memory_provider`'s `mirror` and `sync` bridges are
///   now reachable. Both verbs post to the SAME endpoint and differ in one documented
///   field: `memory.store` sends `infer: false` (the caller already decided the fact,
///   so Mem0 stores the text as-is) while `memory.sync` leaves Mem0's default
///   inference on and lets it mine the raw turn. That endpoint is ASYNCHRONOUS —
///   it answers `{message, status: "PENDING", event_id}` — so neither verb returns a
///   fact id and `event_id` must never be fed to `memory.forget`; both bridges are
///   fire-and-forget and never read the response, which is why this is acceptable.
///   `memory.context` stays UNBOUND because Mem0 publishes no standing-summary
///   endpoint (see the memory section of https://docs.mem0.ai/llms.txt), so while Mem0
///   is selected the facade serves four of the five memory verbs.
///   The entity id is pinned from ONE `mem0.user-id` preference through `arg_defaults`
///   but sits in two different places, because Mem0's own API does: INSIDE `filters`
///   for search (a top-level `user_id` is rejected with 400) and TOP-LEVEL for add.
///   Copying the search shape onto add would drop the entity and the write would be
///   rejected — see `plugins-store/plugins/mem0/README.md`.
/// - `honcho.manifest.json` — Honcho hosted memory tool plugin (BYOK, `api.honcho.dev`
///   v3 REST API). The FIRST provider of `memory.context`, which is why it exists:
///   `memory_provider::context` and the `memory.provider-context` setting had no
///   provider that declared the verb, so that kernel bridge was unreachable by
///   construction. `selectable`, claiming NO `default` — `@ryu/memory` keeps it.
///   `memory.context` binds Honcho's Dialectic endpoint,
///   `POST /v3/workspaces/{workspace_id}/peers/{peer_id}/chat`, whose documented
///   response is `{content}` — one of the four keys `memory_provider::summary_text`
///   reads. That is why the binding declares NO `response` map: the facade's
///   un-normalized `{provider, raw}` passthrough puts `content` exactly one level in,
///   where `summary_text` finds it, whereas ANY `response` map would rewrite the
///   payload into `{provider, results:[…]}` — a shape that function cannot read, so
///   mapping it "properly" would silently produce no context at all.
///   `memory.search` binds `POST .../peers/{peer_id}/search`, which searches that
///   peer's MESSAGES (conversation text) rather than Honcho's derived conclusions;
///   worth knowing because the `prefetch` bridge is on by default. Honcho's `limit`
///   maxes at 100 against the canonical 50, so it NARROWS nothing and no `arg_clamp`
///   is declared.
///   Both WRITE verbs (`memory.sync`, `memory.store`) are bound through an
///   ADAPTER, and the reason they need one is the cleanest example of why adapters
///   exist. Honcho's only documented write is
///   `POST /v3/workspaces/{workspace_id}/sessions/{session_id}/messages`, whose
///   `messages[]` items each require a `peer_id`. `arg_template` can build an array of
///   objects, but `map_args_with_defaults` expands the template from the CALLER's
///   arguments only — `arg_defaults`, and therefore `pref:` tokens, are merged after
///   and cannot reach inside it — so the per-install peer id had nowhere to go and
///   both verbs went unbound, which is what made `memory.mirror-builtin` (default ON)
///   inert while Honcho was selected. An adapter receives those defaults ALREADY
///   RESOLVED, so the peer lands inside `messages[]` without hardcoding one bucket
///   for every install. Session and peers are caller-named and the adapter upserts
///   them on first write (optimistically: one request in the steady state, two extra
///   only when the write reports the resource missing), so nothing has to be created
///   by hand. Ryu's own replies are written as a SEPARATE peer — attributing an
///   assistant turn to the user's peer would poison the representation Honcho derives
///   about them. `memory.forget` is still unbound: Honcho documents no
///   message-delete endpoint, which no adapter can invent.
///   Workspace and peer are pinned per install from `honcho.workspace-id` /
///   `honcho.peer-id` through `arg_defaults`, filling the two URL path placeholders;
///   unset, the token drops and the call fails loudly with a missing path parameter
///   rather than quietly reading somebody else's bucket. `reasoning_level` is layered:
///   the tool's `body_defaults` pin `minimal` (the kernel abandons a memory provider
///   after `PROVIDER_TIMEOUT`, 4s, and a deeper Dialectic pass routinely costs more),
///   and the optional `honcho.reasoning-level` preference overrides it because
///   `body_defaults` merge UNDER the args — see `plugins-store/plugins/honcho/README.md`.
/// - `bytebot.manifest.json` — the SECOND provider of `computer.control`, which until
///   now had only `ghost` and so could not be swapped at all. It binds Bytebot's
///   `bytebotd` daemon (https://github.com/bytebot-ai/bytebot), a documented local
///   HTTP surface: every action is `POST /computer-use` with `{action, …}`, so the
///   six runnables differ only in an `action` constant in `body_defaults` and each
///   verb binding stays a pure rename. `selectable`, claiming NO `default` — ghost
///   keeps it. THE TARGET IS NOT THIS MACHINE: bytebotd drives the desktop it runs
///   on, a containerized Linux desktop in the shipped product, the same
///   local-vs-remote relationship `browser.control` has between the Chromium sidecar
///   and a hosted browser. The daemon has NO authentication, hence no BYOK secret
///   field and a loopback-only URL (grant `tool:http-egress:127.0.0.1`, already in
///   the Gateway allowlist); its port is fixed at Bytebot's documented 9990.
///   That port is fixed by CHOICE, not by the grammar. A `pref:` token cannot be
///   written into a `url` string, but a resolved `arg_defaults` value lands in the
///   args map and the args map is exactly what fills `{placeholder}` path segments
///   — which is how honcho pins its workspace and peer ids into a URL today (see
///   the honcho note above). The blocker is behavioural: an unresolved `pref:`
///   DROPS its argument, and a missing path parameter is a hard error, so a
///   `{port}` placeholder would turn a fresh install from "works at 9990" into
///   "fails until you open settings" (a settings field's `default` is UI-only and
///   is never seeded into the preferences store).
///   FIVE of the six verbs are served, and the three exclusions are each a rule, not
///   an omission:
///   * `computer.focus_app` is UNBOUND. Bytebot's `application` action validates a
///     closed seven-value enum (firefox/1password/thunderbird/vscode/terminal/
///     desktop/directory) while the canonical verb takes a free-form app name, so
///     `focus_app("Safari")` would be a schema-legal call that 400s. The action is
///     still reachable natively as `bytebot.application`, whose own `input_schema`
///     carries that enum so an illegal call cannot be composed.
///   * `computer.scroll` DROPS the canonical `x`/`y` instead of templating them.
///     `arg_template` builds an object shape unconditionally, and Bytebot's
///     `coordinates` is `@IsOptional @ValidateNested` over a `{x, y}` both
///     `@IsNumber` — so a scroll with no coordinates (legal: they are optional in the
///     canonical schema) would send `coordinates: {}` and be rejected. Dropping them
///     scrolls at the pointer's current position, exactly the fallback the canonical
///     schema's own `x` description warns about.
///   * `amount` is CLAMPED to 1..=10 onto `scrollCount`. Bytebot counts WHEEL TICKS
///     and sleeps 150ms between them, so an `amount` a model intends as pixels (500)
///     would wedge the desktop for over a minute. `count` gets no clamp: the
///     canonical max is 3 and Bytebot has no upper bound, so it would narrow nothing.
///   `computer.key` binds `type_keys` (nut.js `pressKey`-all then `releaseKey`-all =
///   one chord), NOT the similarly-named `press_keys`, which is a half-action taking
///   a required `press: up|down` and would leave modifiers physically held down.
///   Only `bytebot.screenshot` sets `unwrap_body` (its `{image}` base64 payload is
///   the result); the five action tools return an EMPTY body on success, which
///   unwrapped reaches the caller as a bare empty string that reads like a failure —
///   the same trap `mem0`'s 204 DELETE documents. Nothing is `fail_open`: for a tool
///   that MOVES A POINTER, converting a dead daemon into `{available:false}` would
///   report "nothing happened" in the one place a caller must be told it failed.
// Test-only catalog fixtures keep the manifest invariants hermetic without
// putting the entire first-party catalog into production Core binaries.
// Safe Actions is a shipped satellite, so its manifest is part of both the
// hermetic validation catalog and the production system set.
const SAFE_ACTIONS_MANIFEST: &str =
    include_str!("../../../../generated/ryu-runtime/apps-store/safe-actions/manifest.json");

const VIDEO_STUDIO_MANIFEST: &str =
    include_str!("../../../../generated/ryu-runtime/apps-store/video-studio/manifest.json");

// Life Recorder is a mirrored, documented opt-in satellite whose sensitive
// grants the Gateway already reviews. It was only in the test catalog (an
// omission: every other apps-store satellite is in both sets), so offline
// install-by-id could not resolve it. Shared const keeps the two lists in step.
const LIFE_RECORDER_MANIFEST: &str =
    include_str!("../../../../generated/ryu-runtime/apps-store/life-recorder/manifest.json");
// Teleprompter is a mirrored opt-in satellite like Life Recorder; it must be in
// both catalogs so offline install-by-id resolves it.
const TELEPROMPTER_MANIFEST: &str =
    include_str!("../../../../generated/ryu-runtime/apps-store/teleprompter/manifest.json");

#[cfg(test)]
const BUILTIN_MANIFESTS: &[&str] = &[
    LIFE_RECORDER_MANIFEST,
    TELEPROMPTER_MANIFEST,
    VIDEO_STUDIO_MANIFEST,
    SAFE_ACTIONS_MANIFEST,
    // Backstage is a Core-tier satellite, so the hermetic test catalog must
    // carry the same manifest identity as the production runtime set. Keeping
    // it here makes CORE_PLUGINS -> manifest and seed grant checks exercise the
    // external-repository Companion instead of passing only in release builds.
    include_str!("../../../../generated/ryu-runtime/apps-store/backstage/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/spider/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/scrapling/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/zvec-grep/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/agentbrowser/manifest.json"),
    // Ego Browser is the opt-in inline-JS browser.control provider. Its
    // manifest is compiled into test catalogs so the Core tier and capability
    // binding invariants cover the same package that the marketplace ships.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/ego-browser/manifest.json"),
    // The opt-in computer.control provider for OpenAI's local Codex Computer Use engine.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/codex-computer-use/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/expect/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/agentation/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/exa/manifest.json"),
    // Ryu Cloud hosted search: a second, opt-in `web.search` provider. Core-local
    // (it reaches `/api/cloud/web-search` over loopback), so it is a fixture.
    include_str!("fixtures/cloud-search.manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/tavily/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/brave/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/serper/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/parallel/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/deepseek/manifest.json"),
    // `docs` is the read-only docs MCP plugin: it declares a REMOTE HTTP server
    // (`docs` → https://docs.ryuhq.com/mcp) serving search + page content from
    // the docs site itself — the same content /llms.txt exposes, as MCP tools.
    // Nothing to spawn, nothing to install: Core-tier so the server registers
    // (see the `CORE_PLUGINS` row), pre-installed so every agent can look up docs.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/docs/manifest.json"),
    // Composio Connect is a hosted OAuth MCP bridge. Keep the fixture in the
    // hermetic catalog so its remote transport, OAuth declaration, and reserved
    // governance grants are validated with every built-in manifest.
    include_str!("../../../../generated/ryu-runtime/plugins-store/external_plugins/composio-connect/manifest.json"),
    // Generic workflow fan-out tool. Core owns the host bridge and delegation
    // engine; the plugin contributes only the validated inline tool surface.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/dynamic-workflows/manifest.json"),
    // Declarative message reactions: the desktop owns the safe native renderer
    // while this manifest owns whether the action is contributed at all.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/reactions/manifest.json"),
    // Side questions and temporary chats are host-rendered chat features. Their
    // manifests own discoverability and lifecycle even though Core keeps the
    // side-model bridge and the desktop chat implementation.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/side-chats/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/ghost-chats/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/kill-switch/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/expanded-composer/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/stats/manifest.json"),
    // Reconnect Retry contributes a bounded desktop host feature. Its retry
    // authorization remains Core-owned; this fixture keeps the package in the
    // hermetic manifest/catalog validation set without making it pre-installed.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/reconnect-retry/manifest.json"),
    include_str!("fixtures/layers.manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/ghost/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/shadow/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/headroom/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/usage-pacer/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/effort-escalator/manifest.json"),
    // The other cost-reduction plugin, and the other shape: `headroom` compresses
    // gateway-routed messages through a Core-hosted transform, while `pxpipe` is a
    // loopback proxy the user points a provider at, imaging the static half of a
    // request so it bills as vision tokens. Core-tier (its managed sidecar would be
    // refused at Community — see the plugin's README), never pre-installed: it needs
    // Node on PATH and a hand-configured provider before it does anything.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/pxpipe/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/laya/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/ollaya/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/kev/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/cloudflare-clef/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/needle3/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/functiongemma/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/firewall/manifest.json"),
    include_str!("fixtures/routing.manifest.json"),
    include_str!("fixtures/sandbox.manifest.json"),
    include_str!("fixtures/engines.manifest.json"),
    include_str!("fixtures/durable.manifest.json"),
    // System-wide predictive typing on/off (Policy-gated, Core-local). Opt-in like
    // firewall/routing/sandbox: enabling the plugin is the single switch for the
    // /api/predict/* brain — there is no separate config toggle.
    include_str!("../../../../generated/ryu-runtime/apps-store/predict/manifest.json"),
    // System-wide dictation + agent-ask (Policy-gated, Core-local). Pre-installed:
    // Island hosts the OS surface; enabling the plugin is the single switch.
    // Formerly hardcoded into Island — extracted as an apps-store app so settings
    // register via contributes.settings_tabs like predict.
    include_str!("../../../../generated/ryu-runtime/apps-store/dictation/manifest.json"),
    // The Island companion overlay itself — a desktop-owned Electron sidecar the
    // shell installs and launches (never a Core sidecar), so its record is a pure
    // settings governance shell: opt-in and install-on-demand (`CORE_PLUGINS` only),
    // and its Island settings tab registers via contributes.settings_tabs the same
    // way every other app does, appearing only once the record is installed.
    include_str!("../../../../apps/island/manifest.json"),
    // Turn-hook plugins (the migrated, formerly-hardcoded features). These ship
    // as built-in fixtures but are built exactly like a third-party plugin would
    // be: a manifest + an inline JS hook reaching Core only through the
    // capability-gated plugin host. `goal`/`proof`/`double-check`/`chat-title`
    // are Core-tier and pre-installed (see `plugins::builtins::CORE_PREINSTALLED`) so
    // their features work on every surface with zero setup, gated cheaply by each
    // hook's `match` block (or preference read for chat-title); `advisor` stays
    // Community (install-then-enable).
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/double-check/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/goal/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/chat-title/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/advisor/manifest.json"),
    // `proof` is `goal`'s stronger sibling: instead of a one-line transcript
    // judge, each round spawns an INDEPENDENT verifier sub-agent (grant
    // `hook:run-agent`) that gathers real evidence with tools before deciding.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/proof/manifest.json"),
    // `receipts` is `proof`'s VISUAL sibling: the verifier sub-agent judges a
    // captured screenshot or screen recording instead of re-reading the workspace,
    // so a round leaves behind an artifact a human can look at afterwards. The hook
    // has no capture capability of its own (no HTTP, no callTool in the sandbox),
    // so the artifact arrives as an absolute path printed in the turn text.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/receipts/manifest.json"),
    // `recap` is the read-side counterpart to those three: instead of steering the
    // turn, it summarizes the one that just finished (`post_assistant_turn` → a
    // `note`), and owns `/recap` on the `pre_user_turn` phase — returning `handled`,
    // so the command is answered by the side model without a main-model turn. Not in
    // `CORE_PREINSTALLED`: unlike the `match`-gated hooks above, a recap is a real
    // model call per long turn, so it has to be a thing the user asked for.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/recap/manifest.json"),
    // `no-more-mistakes` is the memory counterpart to those: instead of steering or
    // summarizing a turn, it mines the moment the user CORRECTS one. A `pre_user_turn`
    // hook turns the correction into one durable rule and files it as a document in a
    // Space (`spaces:docs` — this is the first turn hook to use that grant, and the
    // reason `host.spaces.ensureSpace` exists: every other Space method needs a uuid a
    // sandboxed hook has no way to learn). A `session_start` hook reads the ledger back
    // at the top of every later conversation, because a rule that only surfaces when
    // the wording happens to retrieve it is not a rule. Community-tier and opt-in: the
    // capture hook cannot be `match`-gated — the pre-gate grammar has no "this message
    // reads like a complaint" — so it costs a sandbox spawn per user turn, `recap`'s
    // reason exactly.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/no-more-mistakes/manifest.json"),
    // `polite-prompts` is the tone counterpart to `auto-expand`: a `pre_user_turn`
    // hook that `replace`s a hostile message with a calm rewrite before the model
    // sees it, keeping every concrete detail. Not in `CORE_PREINSTALLED` for
    // `no-more-mistakes`' reason: "this message is hostile" has no `match` pre-gate,
    // so the cheap gate is a regex sweep inside the hook — a sandbox spawn per user
    // turn, plus a side-model call on each message it flags.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/polite-prompts/manifest.json"),
    // `no-ai-slop` bundles the editing skill of the same name and runs it on the
    // turn that just finished. It is the one turn hook here with NO `match` gate:
    // "every completed answer" is the feature, so it cannot pre-gate on a flag or a
    // command. The composer toggle is a manual override for when the automatic pass
    // count is 0, not the arming switch. Its `continue` loop is bounded three ways —
    // a transcript-derived pass counter (the injected turn's own header is the
    // marker), a clean verdict from the reviewer, and Core's `MAX_CONTINUE_TURNS` —
    // and the hook clamps its pass setting well under that cap so a large value
    // degrades to fewer passes instead of a loop that stops mid-rewrite. Not in
    // `CORE_PREINSTALLED` for `recap`'s reason, doubled: a sandbox spawn per turn AND
    // a sub-agent per reviewed answer, on the user's budget.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/no-ai-slop/manifest.json"),
    // `agent-comms` is the agent-to-agent mailbox: `agents.directory` /
    // `agents.send` / `agents.thread`, shipped as ordinary
    // registry tools so EVERY agent gets them (Pi through its MCP extension, an
    // ACP agent through the in-process `mcp_bridge`, the gateway plane through
    // the tool loop) rather than one runtime's private feature.
    //
    // Reads and writes are deliberately split across the two seams. A tool WRITES
    // (`caller.agent_id`, host-derived, is the sender — a model naming someone
    // else in its arguments cannot forge it), and the `pre_user_turn` hook is the
    // only READER of an inbox, because `ctx.agent_id` is the one place "whose mail
    // is this" is answered by Core. A tool that took a `for_agent` argument would
    // be a spoofable read of another agent's mailbox.
    //
    // Three independent stops keep a chain finite: a hop counter carried on the
    // message and re-read from the conversation (or, inside a delegated run, the
    // agent) that received it; a `busy` marker on BOTH ends of an `ask` so A→B→A
    // is refused rather than deadlocked; and the refusal that an agent cannot
    // address itself. Not in `CORE_PREINSTALLED` for `no-ai-slop`'s reason: the
    // delivery hook has no `match` gate (the inbox is keyed by agent, and
    // `stateful` matches on the conversation), so it costs a sandbox spawn per
    // turn.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/agent-comms/manifest.json"),
    // Writing Style is a skill-only, install-on-demand plugin. Keep its manifest
    // in the hermetic catalog so Core validates the runnable and the package's
    // skill lifecycle contract, but do not add it to the production runtime set:
    // bundled skill bodies are materialized from an installed package tree.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/writing-style/manifest.json"),
    // LLM Wiki is the Space-backed companion to the universal Agent Skills
    // layout. It is install-on-demand: the manifest belongs in the hermetic
    // catalog so the skill runnable and Spaces dependency are validated, while
    // its body is materialized from the installed package tree.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/llm-wiki/manifest.json"),
    // `rules` discovers Cursor- and Claude-style project rules and exposes the
    // agent-edit panel contract. Its context hook injects normalized project
    // rules plus per-agent base rules into the latest outbound message, for both
    // OpenAI messages and ACP prompts, leaving the cacheable prefix untouched.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/rules/manifest.json"),
    // `agents-md-tail` is an experimental, opt-in context hook. It repeats the
    // current project instructions at the end of the latest outbound message
    // while keeping the chat-visible transcript and the cacheable prefix
    // unchanged. Rules runs first when both are enabled because context
    // rewrites are first-writer-wins.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/agents-md-tail/manifest.json"),
    // `plan-continue` keeps a plan moving while the composer's plan-mode pill is
    // on, by injecting its own follow-up turn when one finishes. Community and
    // NOT in `CORE_PREINSTALLED` for the reason the others are on: this one spends
    // the user's tokens unattended, so it has to be a thing they asked for. Its
    // hook still pre-gates on `match.flag`, and the flag is the completeness
    // signal too — an approved `ExitPlanMode` writes it back off.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/plan-continue/manifest.json"),
    // `auto-continue` is `plan-continue`'s general sibling: instead of keying on
    // the plan-mode pill, its hook arms per-conversation via `/auto-continue` and
    // asks a LOCAL scanner sub-agent (`hook:run-agent`, `code_read` preset) to read
    // the reply AND the real workspace, then continues only when the scanner
    // explicitly reports work another turn could finish now. Community and NOT in
    // `CORE_PREINSTALLED` for `plan-continue`'s reason and then some: a scanner agent
    // run per turn spends the user's tokens unattended, so it has to be a thing
    // they asked for. Its `match.stateful` gate is the arming switch — presence of
    // the KV record — so an unarmed conversation costs one KV read, not a sandbox
    // spawn, and the loop is off by default.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/auto-continue/manifest.json"),
    // The two Pi capabilities Core used to hardcode into every managed-Pi spawn,
    // now plugins the user can turn off: `pi-shell` (background bash) and
    // `pi-subagent` (the `Task` tool). Each ships ONE `contributes.pi_extensions`
    // row pointing at the TypeScript in its own package; `pi_config::app_extensions`
    // materializes it into `~/.ryu/pi-agent/extensions/` for the next Pi process.
    //
    // Core-tier is a REQUIREMENT here, not a promotion, and for the same reason
    // `scrapling`'s note above gives: `may_ship_pi_extensions` auto-allows a
    // manifest's `pi_extensions` only for compiled-in manifests, while a
    // Community-tier plugin needs the approved `pi:extension` grant — off the
    // Gateway's default allowlist and in a reserved namespace, so operator-only. A
    // Community-tier version of either would materialize nothing and be dead on
    // arrival. Both are also in `CORE_PREINSTALLED`, because they were unconditional
    // before this move and not pre-installed would silently strip background bash and
    // sub-agents from the flagship agent on every fresh install.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/pi-shell/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/pi-subagent/manifest.json"),
    // `pi-monitor` is the third Pi capability: a from-scratch `monitor` tool
    // (the same idea as Claude Code's `Monitor`) for the managed Pi agent —
    // watch a command or WebSocket, stream every line, and end on an `until`
    // match, exit, or timeout. Same carriage as its two siblings: ONE
    // `contributes.pi_extensions` row pointing at the TypeScript in its own
    // package, materialized by `pi_config::app_extensions` into
    // `~/.ryu/pi-agent/extensions/` for the next Pi process. Core-tier (a
    // Community-tier plugin needs the operator-only `pi:extension` grant) and
    // in `CORE_PREINSTALLED` like the other two, because a not pre-installed capability
    // that mirrors a first-class Claude Code tool would read as a regression.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/pi-monitor/manifest.json"),
    // `pi-copy` is the fourth: the `copy_paste` tool, which copies or moves a
    // block of text between or within files byte-for-byte so the model never
    // retypes it (the lossy, token-expensive path `edit`/`write` force). Same
    // carriage, same Core-tier requirement, and in `CORE_PREINSTALLED` because it
    // is a default file tool for the flagship agent, not an opt-in extra.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/pi-copy/manifest.json"),
    // `rtk` surfaces the built-in RTK (Rust Token Killer) command-wrapping tool
    // (`rtk.run`) as an installable plugin. Like `spider`, it is a fully
    // declarative `command`-backend tool: the fixture CARRIES its runnable (the
    // native `sidecar/mcp/rtk.rs` provider was deleted, so there is nothing to
    // double-list — same EXCEPTION as spider). The `rtk` binary is BYO, reached
    // through the command-tool allowlist. The fixture also contributes the Phase-2
    // auto-wrap settings that drive `crate::rtk_config` (NOT a tool). Community-tier,
    // opt-in.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/rtk/manifest.json"),
    // `ripgrep` exposes the upstream `rg` binary as fixed, read-only command
    // tools (`ripgrep.search` and `ripgrep.files`). It is BYO and Community-tier:
    // the Gateway approves the reviewed `tool:command:rg` grant, while the node
    // owner supplies the absolute binary path through the command allowlist.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/ripgrep/manifest.json"),
    // `just-bash` exposes Vercel Labs' `just-bash` CLI as one fixed command tool
    // (`just-bash.run`). It is BYO and Community-tier: the Gateway approves the
    // reviewed `tool:command:just-bash` grant, while the node owner supplies the
    // absolute binary path through the command allowlist.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/just-bash/manifest.json"),
    // `security-guidance` ports Anthropic's security-guidance Claude Code plugin
    // onto Ryu's turn-hook substrate: a flag-gated `post_assistant_turn` hook that
    // (1) runs a ~22-rule regex pattern scan over the last answer and (2) does a
    // second-model diff review via `host.sideModel` (grant `hook:side-model`),
    // surfacing findings as an out-of-band note. Toggle + `/security` command +
    // reviewer-model picker mirror `double-check`. Community-tier, opt-in.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/security-guidance/manifest.json"),
    // security-scanner is a model-agnostic, read-only security workbench:
    // independent architecture, hunt, configuration, and attack-path delegates;
    // report synthesis; diff mode; finding verification; and patch proposals
    // that never apply a change. No vendor-specific model is embedded.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/security-scanner/manifest.json"),
    // `bitwarden` surfaces the Bitwarden Secrets Manager CLI (`bws`) as four
    // declarative `command`-backend tools (`bitwarden.status` / `__projects` /
    // `__list` / `__get`). Faithful to Hermes's Bitwarden Secrets Manager feature:
    // one machine-account bootstrap token (`BWS_ACCESS_TOKEN`, read from Core's
    // process env via `command_env`) replaces N provider keys, and the agent pulls
    // credentials on demand instead of them living in plaintext config. Like
    // `spider`/`rtk` it is a fully declarative plugin — the fixture CARRIES its
    // runnables (there is no Rust provider), and the `bws` binary is BYO, reached
    // through the command-tool allowlist (seeded at `~/.ryu/bin/bws`). The optional
    // `BWS_SERVER_URL` env mirrors Hermes's `secrets.bitwarden.server_url` region
    // knob. Community-tier, opt-in.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/bitwarden/manifest.json"),
    // `auto-expand` is the first `pre_user_turn` hook: before a message is sent it
    // calls a configurable model (`hook:side-model`) to rewrite the prompt into a
    // clearer form and returns a `replace` directive, so the improved prompt is
    // what gets sent and persisted. Composer toggle (auto-expand every message) +
    // `/expand` command (one-off). Core-tier, pre-installed; the flag/command `match`
    // keeps it free when idle.
    include_str!("fixtures/auto-expand.manifest.json"),
    // `session-context` is a reference `session_start` hook: on the first turn of a
    // conversation it injects the current date/time (a common blind spot for local
    // models) via a `replace`/`inject` directive. Community-tier, opt-in; the
    // reference a third party forks for richer setup-context injection. The other
    // new phases (pre/post_tool_use, subagent_stop, session_end, notification) fire
    // from off-chat-path sites through the process-global dispatcher; their
    // reference fixtures (`tool-firewall`, `hook-observers`) are deliberately NOT
    // registered here so those hot paths (esp. per tool call) stay lookup-free
    // until a user installs a plugin that actually uses them.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/hook-session-context/manifest.json"),
    // RAG capability: the default in-process embeddings+retrieval provider. Declares
    // `provides: [rag]` + `requires: [engines]` so the capability graph resolves
    // rag→engines for real (disable-safety: engines can't be disabled out from under
    // an enabled rag). A GraphRAG/third-party provider app can bind `rag` to swap it.
    include_str!("fixtures/rag.manifest.json"),
    // Mail (Agent Inboxes): a built-in app whose out-of-process `ryu-mail` sidecar
    // Core spawns (local sibling binary) and proxies `/api/mail/*` to via the
    // generic ext-proxy `public_mount` mechanism — the acceptance test proving the
    // generic loader replaces the retired hand-coded `sidecar/mail.rs`. Pre-installed,
    // so the externally-committed inbound-webhook URL resolves out of the box.
    include_str!("../../../../generated/ryu-runtime/apps-store/mail/manifest.json"),
    // Browser (W9): a real-Chromium Electron browser Core runs as a `local` sidecar
    // and exposes as the grant-gated `browser.control` capability (list/open/navigate
    // tabs, screenshot, read titles, privileged JS eval). CORE built-in — listed in
    // `SYSTEM_PLUGINS` + `CORE_PREINSTALLED`, so it is seeded enabled on a fresh install
    // and uninstall-protected (the workspace "Browser" tab uses this sidecar instead of
    // the fallback iframe). `lazy` + idle-stop keep the Electron GUI cold until the
    // desktop Browser panel first calls it through the ext-proxy — it does not spawn on
    // boot, only on first use.
    include_str!("../../../../generated/ryu-runtime/apps-store/browser/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/whatsapp/manifest.json"),
    // Simulators: iOS Simulator (`simctl`, macOS + Xcode) + Android Emulator (`adb`)
    // control Core runs as a dependency-free `local` sidecar, exposing the grant-gated
    // `simulator.control` capability. OPT-IN — NOT in `CORE_PREINSTALLED`,
    // so the toolchain-wrapping sidecar never spawns unless a user enables it. `lazy` +
    // idle-stop keep it cold until the desktop Simulator panel calls it through the
    // ext-proxy. Availability is a RUNTIME probe (`/capabilities`): iOS shows only on a
    // Mac with Xcode; Android wherever the SDK is present.
    include_str!("../../../../generated/ryu-runtime/apps-store/simulator/manifest.json"),
    // Virtual Desktop: an interactive headless desktop for any node. The `ryu-desktop`
    // sidecar brings up Xvfb + a window manager + a loopback VNC server, and Core's
    // generic WebSocket ext-proxy (`/api/ext/ws/<plugin>/<route>`) carries the desktop
    // panel's noVNC stream to it — so managed-cloud, self-hosted and local nodes all
    // get a live, driveable desktop with no new firewall port. Ghost drives the SAME
    // `DISPLAY` (Core passes it through the MCP env allowlist), so agents and the human
    // watch/control one screen. OPT-IN like the browser/simulator — NOT in
    // `CORE_PREINSTALLED`, because the virtual-desktop toolchain (xvfb/tigervnc) is not
    // on a normal install; the panel prompts to enable + install it.
    include_str!("../../../../generated/ryu-runtime/apps-store/desktop/manifest.json"),
    // UGC: a creator-marketing campaign tracker (campaign briefs + budgets, a creator
    // roster, post submissions with approve/reject review, per-post metric snapshots
    // refreshed through a curated Composio action map, and CPM/flat payouts accrued,
    // approved and marked paid). Fully manifest-driven like Mail: the whole surface is
    // out-of-process in the `ryu-ugc` sidecar (a `local` sibling binary) and Core reaches
    // `/api/ugc/*` through the generic ext-proxy `public_mount` — there is no hand-coded
    // Rust proxy and no Core-side UGC code. OPT-IN like the browser/simulator — NOT in
    // `CORE_PREINSTALLED`, so the sidecar binary a normal install does not carry is never
    // spawned unless a user enables the app. Its client surface is a desktop DOCK PANEL
    // (`contributes.dock_panels`, `panel: "native"`), not a companion, so it ships no UI
    // bundle and needs no `plugins::seed` row.
    include_str!("../../../../generated/ryu-runtime/apps-store/ugc/manifest.json"),
    // Outpost — social scheduling + publishing. Manifest-driven exactly like Mail and
    // UGC: the whole surface (workspaces, accounts, drafts, the durable retrying publish
    // queue, the reply inbox, engagement history, templates) lives out-of-process in the
    // `ryu-social` sidecar (a `local` sibling binary on 8005 — 8004 was already claimed
    // by `@ryu/ugc`), and Core reaches `/api/social/*` through the generic ext-proxy
    // `public_mount`. There is no hand-coded Rust proxy and no Core-side social code; the
    // crate does not even path-depend on `apps/core`. Unlike UGC its client surface IS a
    // full-page Companion (`ui_format:"html"`, Path B) driving the sidecar through the
    // `social:crud` bridge forwarder, so it ships a UI bundle and DOES need a
    // `plugins::seed` row. OPT-IN: not in `CORE_PREINSTALLED`, so a normal install never
    // spawns the sidecar unless a user enables the app.
    include_str!("../../../../generated/ryu-runtime/apps-store/social/manifest.json"),
    // Autopilot is a full-page Companion over the generic agent, storage, catalog,
    // shell, and toast host bridges. It owns the company brief and cycle ledger;
    // the selected Ryu agent owns the actual tool loop. It is opt-in because a
    // cycle can spend model budget and propose work across enabled apps.
    include_str!("../../../../generated/ryu-runtime/apps-store/autopilot/manifest.json"),
    // Content — a local-first short-form content app. It owns no
    // sidecar; its frame talks only through the generic model/media/storage bridges
    // and can optionally hand captions to Outpost through `social:crud`.
    include_str!("../../../../generated/ryu-runtime/apps-store/content/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/convert/manifest.json"),
    // Token Table — a cosmetic six-seat Hold'em Companion over the generic
    // `app:http` + `app:realtime` bridges. Its authoritative SQLite game state
    // lives in the standalone `ryu-token-table` sidecar; Core only loads the
    // manifest and generic transport contracts.
    include_str!("../../../../generated/ryu-runtime/apps-store/token-table/manifest.json"),
    // Rooms is Core-tier so its active-node sidecar may run through Core's
    // generic lifecycle; keep the manifest in the hermetic test catalog too so
    // the Core-tier ↔ built-in-manifest invariant covers the shipped app.
    include_str!("../../../../generated/ryu-runtime/apps-store/rooms/manifest.json"),
    // Harbor — an object-first CRM over the `ryu-crm` sidecar (a `local` sibling binary
    // on 8009; 8007 was contested by three concurrently built apps and 8008 taken by
    // `@ryu/news`). Same zero-coupling posture as Outpost above — Core links no CRM code
    // and the crate does not path-depend on `apps/core` — but its client surface is a
    // NATIVE DOCK PANEL, not a Companion. That is the whole difference and it removes
    // work rather than adding it: a dock panel fetches `/api/ext/@ryu/crm/*` over the
    // generic ext-proxy directly, so there is no `ui_code` bundle, no `plugins::seed`
    // row, and none of the per-app bridge rows in `rpc.ts`/`host_api.rs` that a
    // CSP-sandboxed companion would have forced. OPT-IN: not in `CORE_PREINSTALLED`.
    include_str!("../../../../generated/ryu-runtime/apps-store/crm/manifest.json"),
    // Deep Read — Recursive Language Models over the `ryu-rlm` sidecar (a `local`
    // sibling binary on 8014). Same zero-coupling posture as Outpost: Core links no
    // RLM code, the crate does not path-depend on `apps/core`, and the one line back
    // is the generic `/api/host/model/complete` callback gated on `hook:side-model`.
    // Its client surface IS a full-page Companion (`ui_format:"html"`, Path B) driving
    // the sidecar through the `rlm:query` bridge forwarder, so it ships a UI bundle
    // and DOES need a `plugins::seed` row. It also contributes a `post_assistant_turn`
    // hook, so it has a `builtin_code` row. OPT-IN: not in `CORE_PREINSTALLED`, so a
    // normal install never spawns the sidecar unless a user enables the app.
    include_str!("../../../../generated/ryu-runtime/apps-store/rlm/manifest.json"),
    // The Whiteboard app — a full-page Companion (`ui_format:"html"`, Path B) that
    // OWNS its Space documents via `spaces:docs`. Ships pre-installed with a UI bundle
    // + host-bridge grants seeded in `main.rs` (the generic CORE_PREINSTALLED loop
    // seeds neither, so it has a dedicated seed block). Replaces the built-in
    // whiteboard editor.
    include_str!("../../../../generated/ryu-runtime/apps-store/whiteboard/manifest.json"),
    // The Canvas app — a full-page Companion (`ui_format:"html"`, Path B) that owns
    // its Space documents via `spaces:docs` and runs generation nodes through the
    // window.ryu media/agent bridge (`media:generate` / `media:transcribe` /
    // `hook:run-agent` / `hook:side-model`) + reads catalogs via `core:list_agents`.
    // Ships pre-installed with a UI bundle + those grants seeded in `main.rs`. Replaces
    // the built-in creative-canvas board.
    include_str!("../../../../generated/ryu-runtime/apps-store/canvas/manifest.json"),
    // Drawesome is a lightweight sketching Companion over the generic app-scoped
    // storage bridge. It is opt-in like the other creative editors and carries a
    // compiled UI so Install → Enable can work without a remote bundle fetch.
    include_str!("../../../../generated/ryu-runtime/apps-store/drawesome/manifest.json"),
    // Slides — an opt-in full-page Companion for local visual slide and thumbnail
    // editing. It has no sidecar: persistence, upload, model, and media work use
    // the generic host bridges, and the bundled UI is seeded on explicit install.
    include_str!("../../../../generated/ryu-runtime/apps-store/slides/manifest.json"),
    // App Studio — an opt-in full-page Companion that builds companion-only Ryu
    // apps with the shared drag-and-drop visual editor and installs them through
    // the generic `apps.installBundle` host bridge. No sidecar; bundled UI is
    // seeded on explicit install.
    include_str!("../../../../generated/ryu-runtime/apps-store/app-studio/manifest.json"),
    // Studio — the local-first short-form content queue. Its Companion
    // uses only app-scoped storage and the governed side-model bridge; its UI is
    // supplied by the satellite/package install rather than embedded in Core.
    include_str!("../../../../generated/ryu-runtime/apps-store/reelfarm/manifest.json"),
    // The Fine-tuning app — a full-page Companion (`ui_format:"html"`, Path B) that
    // drives its own `ryu-finetune` sidecar through the generic ext-proxy and OWNS its
    // Unsloth training sidecar (a
    // manifest-declared Python process spawned on the Core-tier auto-run path, so it
    // declares no `sidecar:process` grant — the Gateway denies that grant at enable).
    // Ships pre-installed with a UI bundle + those grants seeded in `main.rs`. Replaces
    // the built-in fine-tuning page.
    include_str!("../../../../generated/ryu-runtime/apps-store/finetune/manifest.json"),
    // Spaces + Meetings — the first REAL plugin→plugin dependency edge.
    //
    // Both have zero runnables (like ghost/shadow), so the record governs them —
    // install/enable/disable. They differ in where the impl lives: `spaces` stays
    // IN-PROCESS (`server/spaces.rs`, no `public_mount`); `meetings` was moved
    // OUT-OF-PROCESS (2026-07-18) and now serves `/api/meetings/*` via a `public_mount`
    // sidecar (`apps-store/meetings/backend`, reached through its `meetings.*`
    // capabilities) — the old in-crate `server/meetings_api.rs` is gone.
    // Declaring a runnable here would register a PHANTOM tool with no implementation.
    //
    // Order matters only for readability: `plugins::seed` resolves the topological
    // order from `requires`, so the dependency is seeded before its dependent no
    // matter how these are listed.
    include_str!("fixtures/spaces.manifest.json"),
    // Meetings `requires` Spaces because it genuinely writes its notes into the
    // "Meetings" Space (the sidecar's note-save path lands in `state.spaces` via the
    // Core-side `MeetingIngest`/spaces seam). Disabling Spaces under it would leave that
    // write path pointing at a disabled capability, which is exactly what
    // `plugins::graph` now refuses.
    include_str!("../../../../generated/ryu-runtime/apps-store/meetings/manifest.json"),
    // Five clean LEAF features turned into out-of-process sidecar Apps (2026-07-18).
    // Each serves its own `/api/<feature>/*` surface OUT-OF-PROCESS via a `public_mount`
    // sidecar bin + the generic ext-proxy loader; no in-process routes remain. The
    // plugin record governs install/enable/disable (toggle via the plugin lifecycle).
    // All five are pre-installed (see `plugins::builtins`) so the surface is reachable on a
    // fresh install — the routes were always-on before, so only a pre-installed seed keeps
    // them reachable (identical to the Meetings/Spaces edge).
    //
    // `research`/`dashboards`/`teams` declare NO `requires`. `clips` requires the
    // `shadow` capture app (it is a Core→Shadow proxy) and `recipes` requires the
    // `ghost` automation app (Ghost owns the RecipeStore) — both real, satisfiable
    // edges (shadow/ghost are pre-installed), so the graph refuses to disable the
    // dependency out from under them.
    include_str!("../../../../generated/ryu-runtime/apps-store/research/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/dashboards/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/teams/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/clips/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/recipes/manifest.json"),
    // Wave-2: five more leaf features turned into Apps (toggle via the plugin lifecycle).
    // Of these `quests` + `healing` now serve `/api/<feature>/*` OUT-OF-PROCESS via a
    // `public_mount` sidecar + the generic ext-proxy loader; `approvals`/`skills`/`learning`
    // remain IN-PROCESS governance shells that gate their own route surface via
    // `require_app_enabled` (`learning` is the Outcome-B in-process exception). All
    // pre-installed so the surface is reachable on a fresh install (the routes were always-on
    // before).
    //
    // `quests`/`approvals`/`skills` declare NO `requires`. `learning` requires the
    // `skills` app (it writes synthesized skills) and `healing` requires the
    // `approvals` app (it delivers proposed fixes into that inbox) — both real,
    // satisfiable edges (skills/approvals are pre-installed), so the graph refuses to
    // disable the dependency out from under them.
    //
    // These manifests are registered UNCONDITIONALLY (no cfg). Only `healing`'s HTTP
    // surface compiles out behind the `healing` cargo feature; its manifest + id must
    // always be present so the pre-installed seed never references a missing manifest —
    // exactly like `research`/clips/recipes (feature-gated module, always-on fixture).
    include_str!("../../../../generated/ryu-runtime/apps-store/quests/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/approvals/manifest.json"),
    include_str!("fixtures/skills.manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/learning/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/healing/manifest.json"),
    // Wave-3: two more leaf features turned into Apps (toggle via the plugin lifecycle).
    // `monitors` now serves `/api/monitors/*` OUT-OF-PROCESS via a `public_mount` sidecar
    // + the generic ext-proxy loader; `hardware` stays IN-PROCESS and gates its route
    // surface via `require_app_enabled`. Both pre-installed so the surface is reachable on a
    // fresh install (the routes were always-on before).
    //
    // Both declare NO `requires`. `monitors` owns ONLY its `/api/monitors/*` surface
    // (the interleaved `/api/activity/*`, `/api/events/*`, and
    // `/api/notifications/*` streams are separate concerns and stay Core-side, ungated).
    // `hardware` gates ONLY the PROTECTED `/api/hardware/devices*` device-registry
    // CRUD; the PUBLIC device channel (`/api/hardware/{ws,pair,display}`) stays ungated
    // because physical ESP32 devices connect there and gating it would break pairing.
    include_str!("../../../../generated/ryu-runtime/apps-store/monitors/manifest.json"),
    include_str!("fixtures/hardware.manifest.json"),
    // Wave-4: two more leaf features turned into governance-shell Apps (toggle via
    // the plugin lifecycle + route gate; impl stays in-crate). Both pre-installed so the
    // gate is transparent on a fresh install (the routes were always-on before).
    //
    // Both declare NO `requires`. `workflows` gates ONLY the PROTECTED workflow
    // surface (`/workflows/*` DAG CRUD + `/api/workflows/catalog/*` templates); the
    // PUBLIC per-workflow webhook (`/api/workflows/:id/webhook`) stays on the public
    // router, ungated, so external systems can POST triggers regardless of the app's
    // enabled bit. Neither is behind a cargo feature — the workflow executor is used
    // by the scheduler/durable/healing/approvals and must always compile.
    //
    // `agents` gates ONLY the `/api/agents/*` catalog/CRUD surface and is additionally
    // LOAD-BEARING (see `plugins::builtins::LOAD_BEARING_PLUGINS`): the composer fetches
    // the agent list on boot, so a disabled Agents app would break chat. The ACP
    // routing/execution substrate that serves a chat turn is kernel and stays untouched.
    include_str!("../../../../generated/ryu-runtime/apps-store/workflows/manifest.json"),
    include_str!("fixtures/agents.manifest.json"),
    // W0 honest-gating baseline: three data-path governance shells whose
    // `/api/{voice,images+video+gifs,memory}/*` routes were mounted RAW before this
    // wave. Each gates its own protected route surface via `require_app_enabled`; the
    // impl stays in-crate (no cargo feature). All three pre-installed (see
    // `plugins::builtins`) so the gate is transparent on a fresh install.
    //
    // `voice` gates ONLY the protected voice data path; the PUBLIC realtime voice WS
    // (`/api/voice/ws`) stays on the public router (browser WS, auth-in-handler).
    // `media` gates ONLY the generative producers; the shared no-cloud blob store
    // (`/api/media/:file` + `/api/media/upload`) stays ungated kernel storage (it also
    // serves TTS audio + chat uploads). `memory` gates ONLY the HTTP CRUD surface; the
    // in-process chat auto-recall path is kernel. None declares `requires`.
    include_str!("../../../../generated/ryu-runtime/apps-store/voice/manifest.json"),
    include_str!("fixtures/media.manifest.json"),
    include_str!("fixtures/memory.manifest.json"),
    // W7 frontend extraction: the webhooks page moved to a sandboxed companion app
    // (`apps-store/webhooks/ui`). Pre-installed, no `requires` — its `/api/webhooks` +
    // `/api/webhook-ingress/status` reads stay ungated on the main router (the host
    // calls them directly, monitors pattern), so this manifest exists only to seed
    // the companion's UI bundle + `webhooks:crud` grant, not to gate a route surface.
    include_str!("../../../../generated/ryu-runtime/apps-store/webhooks/manifest.json"),
    // W7 frontend extraction: the activity-feed page moved to a sandboxed companion
    // app (`apps-store/activity/ui`). Pre-installed, no `requires` — its read-only
    // `/api/activity` stays ungated on the main router (the host calls it directly,
    // monitors pattern), so this manifest exists only to seed the companion's UI
    // bundle + `activity:read` grant, not to gate a route surface.
    include_str!("../../../../generated/ryu-runtime/apps-store/activity/manifest.json"),
    // Help Center is a first-party Space-backed desktop companion. Its manifest is
    // compiled into the catalog so the pre-installed seed can resolve its identity.
    include_str!("../../../../generated/ryu-runtime/apps-store/help-center/manifest.json"),
    // Sites is the first-party public-edge workspace. Its companion owns the
    // project/deployment/domain/connector control surface; the future managed
    // edge remains a generic RyuRelay/control-plane seam rather than app-specific
    // Core routing.
    include_str!("../../../../generated/ryu-runtime/apps-store/sites/manifest.json"),
    // Forms owns its editor, public respondent pages, and submission store in the
    // satellite. Core registers its manifest and uses the generic ext-proxy.
    include_str!("../../../../generated/ryu-runtime/apps-store/forms/manifest.json"),
    // Bot Flows owns its flow builder, public chat pages, embed script, and
    // conversation store in the satellite. Core registers its manifest and uses
    // the generic ext-proxy.
    include_str!("../../../../generated/ryu-runtime/apps-store/bot-flows/manifest.json"),
    // Bookmarks is an extension contribution and desktop Companion that owns
    // app-scoped Space documents; Core owns the RAG index, visibility, and tenancy
    // checks.
    include_str!("../../../../generated/ryu-runtime/apps-store/bookmarks/manifest.json"),
    // W7 frontend extraction: the timeline page moved to a sandboxed companion app
    // (`apps-store/timeline/ui`). Pre-installed, no `requires` — Shadow's device-local
    // `/timeline` + `/journal` + `/frame` live on the Shadow sidecar (:3030), not the
    // Core router, and the desktop host calls them directly (monitors pattern), so this
    // manifest exists only to seed the companion's UI bundle + `timeline:read` grant,
    // not to gate a route surface.
    include_str!("../../../../generated/ryu-runtime/apps-store/timeline/manifest.json"),
    // The Calendar app — a sandboxed companion (`ui_format:"html"`). It was already
    // in the pre-installed seed set (`plugins::seed` maps CALENDAR_UI_HTML) and routed
    // in the desktop (`/calendar`), but its MANIFEST was never registered here, so
    // the record seeded with no manifest and calendar could not appear in
    // `/api/plugins`, plugin contributions, or the marketplace Apps catalog. Register
    // it so it loads like every other companion.
    include_str!("../../../../generated/ryu-runtime/apps-store/calendar/manifest.json"),
    // Chat Broadcast is a desktop-only companion. Core embeds its manifest so the
    // pre-installed host bridge and sidebar contribution are available before the
    // marketplace is reachable.
    include_str!("../../../../generated/ryu-runtime/apps-store/chat-broadcast/manifest.json"),
    // The Warmup app — a sandboxed companion (`ui_format:"html"`) that schedules a
    // keep-alive ping to each subscription agent so its rolling usage window is
    // already open when the user starts work. Opt-in (seeded DISABLED): it spends
    // subscription usage on the user's behalf, which is not something to switch on
    // for someone. No `requires` and no route surface of its own — the desktop host
    // drives `/api/agents` + `/heartbeat/jobs` for it (the monitors pattern), so this
    // manifest exists to seed the companion's UI bundle + `warmup:crud` grant.
    include_str!("../../../../generated/ryu-runtime/apps-store/warmup/manifest.json"),
    // W7 frontend extraction: the SKILL.md authoring editor moved to a sandboxed
    // companion app (`apps-store/skill-editor/ui`). Pre-installed, no `requires` — the
    // `/api/skills` authoring endpoints stay ungated on the Core router (the desktop host
    // calls them directly, monitors pattern), so this manifest exists only to seed the
    // companion's UI bundle + `skills:crud` grant, not to gate a route surface.
    include_str!("../../../../generated/ryu-runtime/apps-store/skill-editor/manifest.json"),
    // The Agent Status app — three sidebar sections (Working / Needs input / Done)
    // over runs and pending approvals. Opt-in, and the leanest shape an app can
    // have: PURE MANIFEST. No runnables, no sidecar, no UI bundle and no route
    // surface of its own — every row is a declarative `sidebar_sections[].spec`
    // the desktop shell fetches through its own authenticated seam. It is Core-tier
    // (but still opt-in) because those reviewed declarations read governed Core
    // routes rather than an owner ext mount; a Community manifest may not do that.
    // It remains the reference for "an app that only rearranges what the shell
    // already knows".
    include_str!("../../../../generated/ryu-runtime/apps-store/agent-status/manifest.json"),
    // Ambient Elevator — a desktop-only declarative audio contribution. The
    // desktop consumes its opaque live-activity spec and owns the singleton
    // player; Core only forwards the manifest contract.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/ambient-elevator/manifest.json"),
    // The Drafts app — a durable outbox. Owns one `sidebar_sections` entry over its
    // own store and one app-shell page, and its state lives OUT-OF-PROCESS in the
    // `ryu-drafts` sidecar (`public_mount` at `/api/drafts`, App-gated via the ext
    // proxy). Like `agent-status` directly above it is Core-tier, but for a different
    // reason: a managed sidecar only spawns for a `CORE_PLUGINS` member. Opt-in (absent from
    // `CORE_PREINSTALLED`) because a pre-installed sidecar app spawns a binary a normal
    // install does not have. Nothing about drafts exists in Core beyond this
    // registration: the shell's dispatcher does the sending, because a manifest
    // sidecar is deliberately spawned without `RYU_TOKEN`.
    include_str!("../../../../generated/ryu-runtime/apps-store/drafts/manifest.json"),
    // `sample-widget` — the REFERENCE third-party MCP widget plugin (a dev
    // template; source lives at `plugins-store/plugins/sample-widget/`). It declares a
    // local Node MCP server (`node server.mjs`) whose `render` tool advertises
    // `_meta.openai/outputTemplate = ui://widget/sample.html` and serves that
    // resource, plus a `contributes.widgets` entry binding `sample_widget.render`
    // to it and the `widget:render` grant. Registered so it parses/loads like every
    // built-in and shows up as an installable example, but deliberately OPT-IN — it
    // is NOT in `plugins::builtins::CORE_PREINSTALLED`, so it never seeds enabled and
    // its `node` server is never spawned unless a developer installs it. The
    // canonical copy under `plugins-store/` and this fixture are byte-identical.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/sample-widget/manifest.json"),
    // The twelve built-in personality profiles (ELI5, I have ADHD, Concise, Explanatory,
    // Learning, Proactive, Plain text, Plain Technical, No AI slop, No Hype, Bro, Gen Z). Zero runnables
    // and zero `permission_grants`: a profile body is inert prose appended to (or
    // replacing) the agent's base instructions
    // for a turn, so nothing evaluates it — the same argument `ThemeContribution`
    // makes for themes, and the reason a style is a plugin CONTRIBUTION rather than
    // its own `CatalogKind` (it inherits install/enable, versioning, signing, the
    // Store detail page and the trust scorecard for free). See
    // `docs/output-styles.md` §4.
    //
    // Each entry's `file` is hydrated into an inline `source` at load time from
    // `builtin_code::BUILTIN_OUTPUT_STYLES` — a built-in ships only this manifest,
    // so an un-embedded style file would resolve to nothing.
    //
    // Pre-installed but INERT: agents default to their own voice and none of the twelve
    // sets `force-for-plugin`, so registering it changes no prompt until a user assigns
    // one in the agent editor or browses the Store's Personality Profiles tab.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/firecrawl/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/jina-reader/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/mem0/manifest.json"),
    // `spidercloud` is the SECOND `web.crawl` provider, which is what finally makes
    // that layer swappable rather than merely marked selectable: the local `spider`
    // CLI stays the declared default, and this one runs the same engine hosted, so a
    // node with no `spider` binary can still serve `web.crawl`. Bound only because
    // Spider Cloud's crawl is SYNCHRONOUS (`run_in_background` defaults to false) —
    // `firecrawl` is deliberately still not a crawl provider because its `/v2/crawl`
    // hands back a job id, and a declarative http tool is one request with no polling
    // loop, so the verb would return a UUID where it promises page content. The
    // canonical `depth` argument is dropped rather than clamped: upstream documents
    // `depth: 0` as "no limit will be applied", the inverse of the canonical "0 = the
    // start page only", and a clamp would hide a semantic inversion instead of
    // declaring the argument unsupported.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/spidercloud/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/honcho/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/bytebot/manifest.json"),
    // The five `document.parse` providers. Each is an apps-store satellite
    // (`apps-store/{anydoc,markitdown,unstructured,docling,mineru}/`) wrapping a different
    // extraction library in its own sidecar, registered exactly like
    // `finetune`: Core-tier so each is governed and disable-able, and each with an
    // EMPTY `permission_grants` — a Core-tier built-in that asked for
    // `sidecar:process` would be DENIED at enable and the enable itself would fail
    // (`plugins::lifecycle`). The contract every provider copies — provides block,
    // ports (8093-8097, dev-shifted to 9093-9097), wire format — is
    // `docs/document-parsing.md` §3-§4.
    //
    // **Exactly one carries `"default": true`, and it is `markitdown`** (see its
    // `provides` block). That is not decoration: with several providers ENABLED and
    // no default, `plugins::binding` falls through to the lexicographically-lowest
    // plugin id, which elects `@ryu/anydoc` — an alphabetical accident, not a
    // product decision. Adding a second `"default": true` does not make that provider
    // win; it re-runs the same tiebreak and lands on AnyDoc again. So: never add a
    // second default, and never drop markitdown's.
    //
    // The flag is dormant on a stock install. Only `markitdown` is in
    // `plugins::builtins::CORE_PREINSTALLED`, so it is the sole ENABLED provider and
    // binding resolves it by "single provider" without ever consulting the flag; the
    // default only decides anything once a user enables a second backend from the
    // Store. The other four are deliberately not pre-installed because they are opt-in —
    // `unstructured[all-docs]` is a 1-2 GB pip install whose native helpers
    // (poppler/tesseract/libreoffice/pandoc) pip cannot supply, and `docling`/`mineru`
    // download ML models on first parse. markitdown is the one small pure-Python
    // install with no native toolchain, which is why it is the shipped default.
    //
    // The consumer is `crate::document_parse` — the single extraction facade behind
    // `/api/documents/parse`. It names no plugin id: the provider is resolved through
    // `plugins::binding` exactly like `web.search`, so a fifth backend stays pure
    // manifest data. Do not add a second call site; route new surfaces through the
    // facade.
    include_str!("../../../../generated/ryu-runtime/apps-store/anydoc/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/unstructured/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/markitdown/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/docling/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/mineru/manifest.json"),
    // Automated Reasoning — the app that decides whether an answer FOLLOWS from a
    // written policy, using a decision procedure rather than a second model's
    // opinion (`apps-store/reasoning/backend`: exact rational arithmetic, a
    // finite-domain search over booleans/enums, Fourier–Motzkin over linear
    // arithmetic, branch-and-bound for integers). Opt-in and install-on-demand: it
    // is a leaf feature that does nothing until someone writes a policy.
    //
    // Three seams, all generic, none of them Core knowing this app exists beyond
    // this line: the `/api/reasoning/*` surface is a `public_mount` sidecar behind
    // the ext-proxy; the agent/workflow surface is the manifest's own `mcp_servers`
    // entry (`reasoning.solve` is the id a workflow `mcp` node takes), auto-allowed
    // because a compiled-in built-in is Core-tier; and the per-turn guardrail is an
    // ordinary `contributes.turn_hooks` entry whose body is embedded in
    // `builtin_code::BUILTIN_CODE_FILES` — the first apps-store row in that table,
    // which the bijection test already covered because it walks BOTH store roots.
    //
    // `hook:side-model` appears in BOTH the sidecar's `host_api.grants` and the
    // top-level `permission_grants`: the host callback authorizes on declared ∩
    // Gateway-approved, so a manifest carrying only one of the two 403s at runtime
    // with nothing at parse time to say why.
    include_str!("../../../../generated/ryu-runtime/apps-store/reasoning/manifest.json"),
    // Mission Control: the project-level view over many chats — recent sessions and
    // what each accomplished, per-day activity, the files several chats keep returning
    // to, and the to-dos left outstanding in threads nobody reopened. Fully
    // manifest-driven like UGC: the whole surface is out-of-process in the
    // `ryu-mission-control` sidecar (a `local` sibling binary) and Core reaches
    // `/api/mission-control/*` through the generic ext-proxy `public_mount`. OPT-IN —
    // NOT in `CORE_PREINSTALLED`, so the sidecar binary a normal install does not carry
    // is never spawned unless a user enables the app.
    //
    // The app stores digests it does not compute, and that inversion is forced rather
    // than chosen: a manifest sidecar's callbacks into Core are `model/complete`, `rpc`
    // and `capability/:cap` (`sidecar/ext_proxy.rs`), none of which reads a
    // conversation, and `messages.parts` is sealed at rest. The desktop derives each
    // digest from the parts it already holds and PUTs it — the same function that
    // renders the shell's in-chat `mission` dock panel, so the two surfaces cannot
    // disagree about a chat.
    //
    // `hook:side-model` appears in BOTH the sidecar's `host_api.grants` and the
    // top-level `permission_grants`, for the reason spelled out on Reasoning above. It
    // buys only the optional narrative summary: every number the dashboard shows is an
    // indexed fact, so a node with no model still gets a working page.
    include_str!("../../../../generated/ryu-runtime/apps-store/mission-control/manifest.json"),
    // Feedback Board — public customer requests plus a private product workspace
    // that connects request triage to Ryu Spaces, Blueprint, and configurable
    // workflow execution. The public board is served through the app's manifest
    // public_mount; Core owns only this manifest registration and generic proxy.
    include_str!("../../../../generated/ryu-runtime/apps-store/feedback-board/manifest.json"),
    // Pull Requests — a GitHub-first review inbox. The app-owned Bun sidecar invokes
    // the user's authenticated `gh` CLI and is reached only through the generic
    // ext-proxy; Core owns no GitHub client, route, port or provider behavior.
    include_str!("../../../../generated/ryu-runtime/apps-store/pull-requests/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/mpp/manifest.json"),
    // Checks — a local-first verification workspace. Its companion owns the
    // project, exploration, check, report, list, and schedule surfaces; Core owns
    // no external provider client, route, port, or remote execution behavior.
    include_str!("../../../../generated/ryu-runtime/apps-store/checks/manifest.json"),
    // Security — a local-first application security workbench. Its companion and
    // bounded static-analysis sidecar own scan, finding, repository, triage, and
    // read-only patch-proposal state; Core carries it only through the generic app
    // lifecycle and authenticated ext-proxy seams.
    include_str!("../../../../generated/ryu-runtime/apps-store/security/manifest.json"),
    // Blueprint — visual plan review. An agent publishes its plan over the app's own
    // MCP server (`blueprint.plan_publish`), a human reads it as rendered markdown
    // blocks plus a dependency graph derived from `steps[].depends_on`, annotates it,
    // and approves or requests changes; the agent reads the verdict back as
    // deterministic text (`blueprint.plan_status`). Opt-in — outside `CORE_PREINSTALLED`,
    // like Reasoning, because it owns an out-of-process binary a normal install does
    // not have, and because it is inert until an agent publishes something.
    //
    // The seams are the same generic three, and again none of them is Core knowing
    // this app exists beyond this line: `/api/blueprint/*` is a `public_mount` sidecar
    // behind the ext-proxy, the agent/workflow surface is the manifest's own
    // `mcp_servers` entry, and there are deliberately NO `turn_hooks` — the plugin
    // sandbox has no HTTP, so a hook could not reach the sidecar that owns the plans.
    // What drives the agent instead is `contributes.output_styles`
    // (`output-styles/visual-planning.md`, embedded in
    // `builtin_code::BUILTIN_OUTPUT_STYLES`): without a style telling the agent to
    // publish before it edits, nothing ever calls the tool and the app is inert.
    include_str!("../../../../generated/ryu-runtime/apps-store/blueprint/manifest.json"),
    // Tuition — a tutor for one learner. Turns the learner's own syllabus and notes
    // into a prerequisite graph of skills, each carrying a Bayesian Knowledge Tracing
    // posterior, and drills the weakest thing they are ready for. The interesting
    // property, and the reason it earns a row here: four of the five item kinds are
    // graded by ARITHMETIC with no model in the loop at all (`apps-store/tuition/
    // backend/src/grade.rs`, with a hand-rolled fixed-point decimal so an item
    // expecting 0.3 does not mark a correct 0.3 wrong), and the one kind a model does
    // mark shows the rubric it was marked against.
    //
    // Every seam is generic: `/api/tuition/*` is a `public_mount` sidecar behind the
    // ext-proxy, the agent/workflow surface is the manifest's own `mcp_servers` entry,
    // and the Study-mode capture is an ordinary `contributes.turn_hooks` entry whose
    // body is embedded in `builtin_code::BUILTIN_CODE_FILES`.
    //
    // `storage:kv` appears in BOTH the sidecar's `host_api.grants` and the top-level
    // `permission_grants`, and it is load-bearing rather than incidental: the turn
    // hook runs in a sandbox with no HTTP and cannot call the sidecar, so the two hand
    // work to each other through Core's own KV. One grant without the other 403s at
    // runtime with nothing at parse time to say why.
    include_str!("../../../../generated/ryu-runtime/apps-store/tuition/manifest.json"),
    // Expenses — the local-first ledger app. Its agent and companion share the
    // `ryu-expenses` sidecar through the generic `app:http` bridge; the agent-facing
    // tool surface is the manifest-owned `expenses` MCP server. It is opt-in and
    // carries no Core-specific route or client implementation.
    include_str!("../../../../generated/ryu-runtime/apps-store/expenses/manifest.json"),
    // Family — the shared family hub (dates and reminders, lists and chores,
    // wishlists, gift ideas). Same opt-in posture as Expenses: one `ryu-family`
    // sidecar behind the generic `app:http` bridge plus a manifest-owned `family`
    // MCP server, with no Core-specific route, client, port, or capability.
    include_str!("../../../../generated/ryu-runtime/apps-store/family/manifest.json"),
    // Places — a shared family map of places to visit and places been. Every seam
    // is generic: `/api/places/*` is a `public_mount` sidecar behind the ext-proxy
    // (Core stamps the caller id that tells family members apart), the agent
    // surface is the manifest's own `places` MCP server, and the Companion's only
    // CSP widening is the OpenFreeMap tile host. Opt-in like Expenses.
    include_str!("../../../../generated/ryu-runtime/apps-store/places/manifest.json"),
    // Decks — hardware control surfaces (USB HID decks, MIDI controllers, game
    // controllers, keyboards and the Touch Bar) driven by the `ryu-decks` sidecar.
    // Every seam is generic: `/api/decks/*` is a `public_mount` behind the ext-proxy,
    // a press raises the app's own declared `hook_events` through `events.emit`, and
    // an "ask an agent" key goes through `chat.startTurn` (and so through Approvals).
    // Beyond these two manifest rows Core holds only its Core-tier id.
    include_str!("../../../../generated/ryu-runtime/apps-store/decks/manifest.json"),
    // Wire — a personal newsroom. Pulls feeds in on a schedule, collapses the same
    // story across every outlet covering it, writes a brief from those clusters, and
    // fires watches on a burst it can explain. Ingest, dedupe (URL canonicalization
    // plus a banded 64-bit SimHash), clustering, the hour-of-day burst test, the
    // boolean topic grammar and the ranking are all deterministic and offline; a model
    // writes only the brief prose and a neutral cluster title.
    //
    // Its `news.search` MCP tool is the reason this is more than a reader: it queries
    // the user's OWN vetted corpus with no web request at all, so an agent can ground
    // an answer in the sources they chose rather than in whatever a fresh search
    // returns. Same generic seams as `tuition` above, with the KV handoff running the
    // other way — the sidecar publishes a ranked snapshot the `pre_user_turn` hook
    // reads.
    include_str!("../../../../generated/ryu-runtime/apps-store/news/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/outreach/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/projects/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/invoices/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/people/manifest.json"),
    // Subtitles — pick a video on this machine, transcribe it, translate the
    // transcript, and write a timed `.srt`/`.vtt` beside the file. Same zero-coupling
    // posture as Outpost: the whole pipeline (container demux, the 16 kHz downmix,
    // the windowed whisper pass, the translation call, cue layout, the job queue)
    // lives out-of-process in the `ryu-subtitles` sidecar on 8013, and Core reaches
    // `/api/subtitles/*` through the generic ext-proxy `public_mount`. Core links no
    // subtitle code and the crate does not path-depend on `apps/core`.
    //
    // Both model hops are LOCAL by default and that is the point of the app: the
    // transcription goes through the extracted `ryu-stt` crate to local whisper.cpp,
    // and the translation goes to the local gateway's on-device model — so a node
    // with no provider configured still subtitles a film, and a file the user has not
    // shared with anyone stays that way.
    //
    // Its client surface IS a full-page Companion (`ui_format:"html"`, Path B)
    // driving the sidecar through the `subtitles:crud` bridge forwarder, so it ships
    // a UI bundle and DOES need a `plugins::seed` row. OPT-IN: not in
    // `CORE_PREINSTALLED`, so a normal install never spawns the sidecar unless a user
    // enables the app.
    include_str!("../../../../generated/ryu-runtime/apps-store/subtitles/manifest.json"),
    // ── Language-server plugins: one per language, mirroring Claude Code ──────
    //
    // These twelve are the `contributes.lsp_servers` binding of Anthropic's
    // official code-intelligence plugins (`anthropics/claude-plugins-official`),
    // so the same config body loads in either host. Each is CONFIG ONLY — it
    // declares how to reach a language server and never bundles the binary; a
    // `command` that is not on PATH is a graceful skip with a visible reason.
    // `crate::lsp` arbitrates the enabled ones into the managed Pi's
    // `ryu-lsp.json`, which is what activates the `ryu-lsp.ts` binding's tools.
    //
    // Community-tier and OPT-IN — deliberately absent from `CORE_PLUGINS` and
    // `CORE_PREINSTALLED`. An enabled LSP plugin puts its server into the managed
    // Pi's config (spawned lazily on the first touched file), so seeding all
    // twelve on a fresh install would write a twelve-server table nobody asked
    // for. The user enables the one language they actually use.
    include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/clangd-lsp/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/csharp-lsp/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/gopls-lsp/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/jdtls-lsp/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/kotlin-lsp/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/lua-lsp/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/php-lsp/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/pyright-lsp/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/ruby-lsp/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/rust-analyzer-lsp/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/swift-lsp/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/typescript-lsp/manifest.json"),
];

// Production Core embeds every first-party manifest that must be available before
// the marketplace is reachable: system apps, mandatory capabilities, and the
// CORE_PREINSTALLED defaults. The remaining compiled catalog is still available
// for discovery and explicit install, but is not loaded into the runtime until a
// user installs it. Keeping the preinstalled set here prevents a fresh node from
// trying to materialize its own defaults over the network.
const CORE_RUNTIME_BUILTIN_MANIFESTS: &[&str] = &[
    VIDEO_STUDIO_MANIFEST,
    LIFE_RECORDER_MANIFEST,
    TELEPROMPTER_MANIFEST,
    SAFE_ACTIONS_MANIFEST,
    // These packages are part of CORE_PREINSTALLED. Keep their manifests in the
    // production registry as well as the hermetic test catalog so a fresh node
    // does not try to materialize its own first-party defaults from a remote
    // marketplace before the catalog is reachable.
    include_str!("fixtures/durable.manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/goal/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/proof/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/receipts/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/double-check/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/chat-title/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/side-chats/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/ghost-chats/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/kill-switch/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/expanded-composer/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/stats/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/reactions/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/rules/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/pi-shell/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/pi-subagent/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/pi-monitor/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/pi-copy/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/spider/manifest.json"),
    // These two MCP providers are Core-tier built-in Store targets. Keep their
    // signed manifests in the production runtime set so install-by-id can
    // resolve them before a remote catalog package is fetched.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/scrapling/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/zvec-grep/manifest.json"),
    // Opt-in local computer.control engine: Core tier is what lets its
    // manifest-owned stdio MCP server register, so the manifest must ship.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/codex-computer-use/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/exa/manifest.json"),
    // Ryu Cloud hosted search: a second, opt-in `web.search` provider. Core-local
    // (it reaches `/api/cloud/web-search` over loopback), so it is a fixture.
    include_str!("fixtures/cloud-search.manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/docs/manifest.json"),
    // Cloudflare Clef is an opt-in typed-decision provider. It stays compiled
    // into the node for offline Marketplace installation, but is not seeded on.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/cloudflare-clef/manifest.json"),
    // Kev is an opt-in local System One provider with no managed sidecar. Compile
    // its manifest so Marketplace installation works without a remote catalog.
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/kev/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/external_plugins/composio-connect/manifest.json"),
    include_str!("fixtures/auto-expand.manifest.json"),
    include_str!("fixtures/agents.manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/ghost/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/shadow/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/agentbrowser/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/ambient-elevator/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/browser/manifest.json"),
    // WhatsApp has no process: the manifest contributes a native workspace entry
    // over the existing Gateway channel adapters.
    include_str!("../../../../generated/ryu-runtime/apps-store/whatsapp/manifest.json"),
    // Chat Broadcast has no process or sidecar: its desktop companion uses the
    // trusted host bridge to list visible conversations and enqueue real user turns.
    include_str!("../../../../generated/ryu-runtime/apps-store/chat-broadcast/manifest.json"),
    // Every apps-store satellite is also a valid standalone-app carriage. Keeping
    // its manifest in the generic production registry lets the standalone host
    // use the normal built-in lifecycle path (and therefore preserve Core-tier
    // sidecar/MCP authority) without adding an app-specific Core route, client, or
    // port. The satellite still owns its sidecar and UI; this list only establishes
    // the compiled manifest identity used by the generic loader.
    include_str!("../../../../generated/ryu-runtime/apps-store/agent-status/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/app-studio/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/approvals/manifest.json"),
    // Backstage is authored in its own repository, but its exact manifest is
    // compiled here so Marketplace installs and standalone bundles retain the
    // same first-party identity without adding an app-specific Core route.
    include_str!("../../../../generated/ryu-runtime/apps-store/backstage/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/blueprint/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/bookmarks/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/calendar/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/canvas/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/checks/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/security/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/clips/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/content/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/convert/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/crm/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/dashboards/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/dictation/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/anydoc/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/docling/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/drafts/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/desktop/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/drawesome/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/expenses/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/family/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/places/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/decks/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/feedback-board/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/finetune/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/healing/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/help-center/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/learning/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/mail/manifest.json"),
    // Meetings is a Core-tier, opt-in sidecar app. It is also a dependency-aware
    // Store install target, so its manifest must be in the production runtime
    // registry before a user can install it and
    // before the public-mount router can register /api/meetings.
    include_str!("../../../../generated/ryu-runtime/apps-store/meetings/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/markitdown/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/mineru/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/mission-control/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/monitors/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/mpp/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/news/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/outreach/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/projects/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/invoices/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/people/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/predict/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/pull-requests/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/quests/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/reasoning/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/rooms/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/reelfarm/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/research/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/rlm/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/recipes/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/simulator/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/sites/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/forms/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/bot-flows/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/slides/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/social/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/subtitles/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/teams/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/timeline/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/token-table/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/tuition/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/ugc/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/unstructured/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/voice/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/warmup/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/webhooks/manifest.json"),
    // Activity is an opt-in companion (not part of the fresh-node seed), but its
    // signed manifest must still be in the production runtime catalog so the
    // Store's built-in install endpoint can resolve it without a remote fetch.
    include_str!("../../../../generated/ryu-runtime/apps-store/activity/manifest.json"),
    // Autopilot and Skill Editor are the same opt-in Companion shape: Core owns
    // their signed manifests and compiled UI carriages, while the fresh-node seed
    // intentionally leaves both disabled until a user installs them.
    include_str!("../../../../generated/ryu-runtime/apps-store/autopilot/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/skill-editor/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/whiteboard/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/apps-store/workflows/manifest.json"),
    include_str!("fixtures/engines.manifest.json"),
    include_str!("fixtures/hardware.manifest.json"),
    include_str!("fixtures/layers.manifest.json"),
    include_str!("fixtures/media.manifest.json"),
    // Memory is a Core-local governance shell. Keep its compiled fixture in the
    // production runtime set so the pre-installed seed can make the authenticated
    // Memory Library routes reachable before Marketplace materialization completes.
    include_str!("fixtures/memory.manifest.json"),
    include_str!("fixtures/rag.manifest.json"),
    include_str!("fixtures/skills.manifest.json"),
    include_str!("fixtures/spaces.manifest.json"),
];

// Opt-in built-in plugins are available to the Store and install endpoint but
// are intentionally absent from the runtime manifest set until installation.
const CORE_INSTALLABLE_BUILTIN_MANIFESTS: &[&str] = &[
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/laya/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/functiongemma/manifest.json"),
    include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/needle3/manifest.json"),
];

#[cfg(not(test))]
const BUILTIN_MANIFESTS: &[&str] = CORE_RUNTIME_BUILTIN_MANIFESTS;

/// IDs whose manifest bytes are trusted because they are compiled into Core.
/// Keep this lookup independent of `parse_and_validate`: tier resolution can
/// happen while a built-in manifest is being validated, so calling the loader
/// here would recurse through the tier gate.
pub(crate) fn compiled_manifest_ids() -> HashSet<String> {
    BUILTIN_MANIFESTS
        .iter()
        .chain(CORE_INSTALLABLE_BUILTIN_MANIFESTS.iter())
        .filter_map(|raw| serde_json::from_str::<PluginManifest>(raw).ok())
        .map(|manifest| canonical_plugin_id(&manifest.id).to_owned())
        .collect()
}

/// The Canvas app's plugin id (its Space documents are `kind = app:<this>`). Shared
/// by the pre-installed seed (`main.rs`), the legacy file-store migration
/// (`server/canvas_migrate.rs`), and the desktop create/route flow.
pub const CANVAS_PLUGIN_ID: &str = "@ryu/canvas";

/// The Canvas app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/canvas/ui`, all JS/CSS inlined). Seeded as the plugin's
/// `ui_code` on a fresh install. Refresh with `scripts/sync-app-fixtures.sh canvas`.
pub const CANVAS_UI_HTML: &str = include_str!("fixtures/canvas.ui.html");

/// The Drawesome app's plugin id and prebuilt Companion bundle. The bundle is
/// sourced from `apps-store/drawesome/ui` and attached by the normal explicit
/// install path, just like the other opt-in Companion apps.
pub const DRAWSOME_PLUGIN_ID: &str = "@ryu/drawesome";
pub const DRAWSOME_UI_HTML: &str = include_str!("fixtures/drawesome.ui.html");

/// The Convert app's plugin id and prebuilt Companion bundle. The app owns
/// browser-local file conversion and uses only the generic storage/toast bridges
/// for its small metadata surface.
pub const CONVERT_PLUGIN_ID: &str = "@ryu/convert";
pub const CONVERT_UI_HTML: &str = include_str!("fixtures/convert.ui.html");

/// The Slides app's prebuilt, self-contained UI bundle. Seeded for explicit app
/// installs through the same compiled-in companion table as the other Path B apps.
pub const SLIDES_PLUGIN_ID: &str = "@ryu/slides";
pub const SLIDES_UI_HTML: &str = include_str!("fixtures/slides.ui.html");

/// The App Studio app's prebuilt Companion bundle (sourced from
/// `apps-store/app-studio/ui`). Seeded for explicit installs through the same
/// compiled-in companion table as the other opt-in Path B apps.
pub const APP_STUDIO_UI_HTML: &str = include_str!("fixtures/app-studio.ui.html");

/// The Whiteboard app's plugin id (its Space documents are `kind = app:<this>`).
/// Shared by the pre-installed seed (`main.rs`), the legacy-kind migration
/// (`server/spaces.rs`), and the desktop create/route flow.
pub const WHITEBOARD_PLUGIN_ID: &str = "@ryu/whiteboard";

/// The Whiteboard app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/whiteboard/ui`, all JS/CSS/fonts
/// inlined). Seeded as the plugin's `ui_code` on a fresh install so the pre-installed
/// companion has a UI without going through `ryu pack` / install-bundle. Refresh
/// with `scripts/sync-app-fixtures.sh whiteboard`.
pub const WHITEBOARD_UI_HTML: &str = include_str!("fixtures/whiteboard.ui.html");

/// The Fine-tuning app's plugin id. Used only by the install seed table
/// (`plugins::seed`), which pairs it with [`FINETUNE_UI_HTML`].
pub const FINETUNE_PLUGIN_ID: &str = "@ryu/finetune";

/// The Fine-tuning app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/finetune/ui`, all JS/CSS inlined).
/// Seeded as the plugin's `ui_code` on a fresh install so the pre-installed companion
/// has a UI without going through `ryu pack`. Refresh with
/// `scripts/sync-app-fixtures.sh finetune`.
pub const FINETUNE_UI_HTML: &str = include_str!("fixtures/finetune.ui.html");

/// The Monitors app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/monitors/ui`, all JS/CSS inlined).
/// Seeded as the plugin's `ui_code` on a fresh install so the pre-installed companion
/// has a UI without going through `ryu pack`. Rebuild with `bun run --cwd
/// apps-store/monitors/ui build` and copy `dist/index.html` to
/// `fixtures/monitors.ui.html` to refresh it.
pub const MONITORS_UI_HTML: &str = include_str!("fixtures/monitors.ui.html");

/// The Automated Reasoning app's plugin id. Shared by the seed table and the
/// companion UI bundle table.
pub const REASONING_PLUGIN_ID: &str = "@ryu/reasoning";

/// The Automated Reasoning app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/reasoning/ui`, all JS/CSS inlined).
/// A built-in ships only its manifest, so this is the ONLY place its frame exists:
/// `plugins::lifecycle::install_app` sources it at install time via
/// `compiled_in_ui_code`. Rebuild with `bun run --cwd apps-store/reasoning/ui build`
/// and copy `dist/index.html` here to refresh it.
pub const REASONING_UI_HTML: &str = include_str!("fixtures/reasoning.ui.html");

/// The Tuition app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/tuition/ui`, all JS/CSS inlined). A built-in ships only its
/// manifest, so this is the ONLY place its frame exists: `plugins::lifecycle::
/// install_app` sources it at install time via `compiled_in_ui_code`. Refresh with
/// `scripts/sync-app-fixtures.sh tuition`.
pub const TUITION_UI_HTML: &str = include_str!("fixtures/tuition.ui.html");

/// The Expenses app's prebuilt, self-contained companion. Its frame reaches the
/// local ledger through the generic own-app `app:http` bridge; refresh with
/// `scripts/sync-app-fixtures.sh expenses`.
pub const EXPENSES_UI_HTML: &str = include_str!("fixtures/expenses.ui.html");

/// The Family hub's prebuilt, self-contained companion. Its frame reaches the
/// family store through the generic own-app `app:http` bridge; refresh with
/// `scripts/sync-app-fixtures.sh family`.
pub const FAMILY_UI_HTML: &str = include_str!("fixtures/family.ui.html");

/// The Wire app's prebuilt, self-contained UI bundle. Same carriage as
/// [`TUITION_UI_HTML`]; refresh with `scripts/sync-app-fixtures.sh news`.
pub const NEWS_UI_HTML: &str = include_str!("fixtures/news.ui.html");

/// The Outreach app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/outreach/ui`, all JS/CSS inlined).
/// It is attached on explicit install through the same compiled-in companion table
/// as the other opt-in apps. Refresh with
/// `scripts/sync-app-fixtures.sh outreach`.
pub const OUTREACH_UI_HTML: &str = include_str!("fixtures/outreach.ui.html");

/// The Autopilot app's prebuilt, self-contained UI bundle. Refresh with
/// `scripts/sync-app-fixtures.sh autopilot` after changing the Companion.
pub const AUTOPILOT_UI_HTML: &str = include_str!("fixtures/autopilot.ui.html");

/// The Projects app's prebuilt, self-contained UI bundle. Refresh with
/// `scripts/sync-app-fixtures.sh projects`.
pub const PROJECTS_UI_HTML: &str = include_str!("fixtures/projects.ui.html");

/// The Invoices app's prebuilt, self-contained UI bundle. Refresh with
/// `scripts/sync-app-fixtures.sh invoices`.
pub const INVOICES_UI_HTML: &str = include_str!("fixtures/invoices.ui.html");

/// The People app's prebuilt, self-contained UI bundle. Refresh with
/// `scripts/sync-app-fixtures.sh people`.
pub const PEOPLE_UI_HTML: &str = include_str!("fixtures/people.ui.html");

/// The Blueprint app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/blueprint/ui`, all JS/CSS inlined —
/// including `@xyflow/react`, which is what makes this bundle bigger than a
/// text-only companion's). Same rule as Reasoning above: a built-in ships only its
/// manifest, so this is the ONLY place its frame exists and
/// `plugins::lifecycle::install_app` sources it at install time via
/// `compiled_in_ui_code`. Refresh it with `scripts/sync-app-fixtures.sh blueprint`
/// rather than by hand — that script runs the vite build and copies
/// `dist/index.html` here, and its `--check` mode is what catches a stale copy.
///
/// The plugin id deliberately lives elsewhere (`plugins::builtins::BLUEPRINT_PLUGIN_ID`)
/// next to the `CORE_PLUGINS` row that actually decides whether the sidecar spawns,
/// which is where a reader looking for "why is this app Core-tier" will be.
pub const BLUEPRINT_UI_HTML: &str = include_str!("fixtures/blueprint.ui.html");

/// The Pull Requests app's prebuilt, self-contained companion. The frame reaches
/// its own sidecar through `app.request`; refresh with
/// `scripts/sync-app-fixtures.sh pull-requests`.
pub const PULL_REQUESTS_UI_HTML: &str = include_str!("fixtures/pull-requests.ui.html");

/// The Security app's prebuilt, self-contained Companion. Refresh with
/// `scripts/sync-app-fixtures.sh security` after changing the workbench UI.
pub const SECURITY_UI_HTML: &str = include_str!("fixtures/security.ui.html");

/// The Workflows app's plugin id (its sandboxed companion drives Core's DAG
/// workflow engine + ghost record→replay). Re-exported from `plugins::builtins`
/// so the seed table and desktop route flow share one definition.
pub const WORKFLOWS_PLUGIN_ID: &str = crate::plugins::builtins::WORKFLOWS_PLUGIN_ID;

/// The Workflows app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/workflows/ui`, React Flow + all
/// JS/CSS inlined). Seeded as the plugin's `ui_code` on a fresh install so the
/// pre-installed companion has a UI without going through `ryu pack`. Rebuild with
/// `bun run --cwd apps-store/workflows/ui build` and copy `dist/index.html` to
/// `fixtures/workflows.ui.html` to refresh it.
pub const WORKFLOWS_UI_HTML: &str = include_str!("fixtures/workflows.ui.html");

/// The Webhooks app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/webhooks/ui`, all JS/CSS — incl. the tree-shaken `@ryu/ui`
/// components — inlined). Seeded as the plugin's `ui_code` on a fresh install so the
/// pre-installed companion has a UI without going through `ryu pack`. Rebuild with
/// `bun run --cwd apps-store/webhooks/ui build` (or `scripts/sync-app-fixtures.sh
/// webhooks`) and copy `dist/index.html` to `fixtures/webhooks.ui.html` to refresh it.
pub const WEBHOOKS_UI_HTML: &str = include_str!("fixtures/webhooks.ui.html");

/// The Quests app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/quests/ui`, all JS/CSS — incl. the tree-shaken `@ryu/ui`
/// components — inlined). Seeded as the plugin's `ui_code` on a fresh install so the
/// pre-installed companion has a UI without going through `ryu pack`. Rebuild with
/// `bun run --cwd apps-store/quests/ui build` (or `scripts/sync-app-fixtures.sh
/// quests`) and copy `dist/index.html` to `fixtures/quests.ui.html` to refresh it.
pub const QUESTS_UI_HTML: &str = include_str!("fixtures/quests.ui.html");

/// The Activity app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/activity/ui`, all JS/CSS — incl. the tree-shaken `@ryu/ui`
/// components — inlined). Seeded as the plugin's `ui_code` on a fresh install so the
/// pre-installed companion has a UI without going through `ryu pack`. Rebuild with
/// `bun run --cwd apps-store/activity/ui build` (or `scripts/sync-app-fixtures.sh
/// activity`) and copy `dist/index.html` to `fixtures/activity.ui.html` to refresh it.
pub const ACTIVITY_UI_HTML: &str = include_str!("fixtures/activity.ui.html");

/// The Timeline app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/timeline/ui`, all JS/CSS — incl. the tree-shaken `@ryu/ui`
/// components — inlined). Seeded as the plugin's `ui_code` on a fresh install so the
/// pre-installed companion has a UI without going through `ryu pack`. Rebuild with
/// `bun run --cwd apps-store/timeline/ui build` (or `scripts/sync-app-fixtures.sh
/// timeline`) and copy `dist/index.html` to `fixtures/timeline.ui.html` to refresh it.
pub const TIMELINE_UI_HTML: &str = include_str!("fixtures/timeline.ui.html");

/// The Skill Editor app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/skill-editor/ui`, all JS/CSS — incl. the tree-shaken `@ryu/ui`
/// components — inlined). Seeded as the plugin's `ui_code` on a fresh install so the
/// pre-installed companion has a UI without going through `ryu pack`. Rebuild with
/// `bun run --cwd apps-store/skill-editor/ui build` (or `scripts/sync-app-fixtures.sh
/// skill-editor`) and copy `dist/index.html` to `fixtures/skill-editor.ui.html` to
/// refresh it.
pub const SKILL_EDITOR_UI_HTML: &str = include_str!("fixtures/skill-editor.ui.html");

/// The Mail (Agent Inboxes) app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/mail/ui`, all JS/CSS — incl. the
/// tree-shaken `@ryu/ui` components — inlined). Seeded as the plugin's `ui_code`
/// onto a DISABLED record so enabling the opt-in `@ryu/mail` app (from the store)
/// mounts the sandboxed companion. Rebuild with `bun run --cwd apps-store/mail/ui
/// build` (or `scripts/sync-app-fixtures.sh mail`) and copy `dist/index.html` to
/// `fixtures/mail.ui.html` to refresh it.
pub const MAIL_UI_HTML: &str = include_str!("fixtures/mail.ui.html");

/// The Calendar app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/calendar/ui`, all JS/CSS — incl.
/// the tree-shaken `@ryu/ui` components — inlined). Seeded as the plugin's `ui_code`
/// (pre-installed companion) so the `/calendar` route mounts the sandboxed companion.
/// Rebuild with `bun run --cwd apps-store/calendar/ui build` (or
/// `scripts/sync-app-fixtures.sh calendar`) and copy `dist/index.html` to
/// `fixtures/calendar.ui.html` to refresh it.
pub const CALENDAR_UI_HTML: &str = include_str!("fixtures/calendar.ui.html");

/// The Help Center app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/help-center/ui`, all JS/CSS inlined).
/// Seeded as the pre-installed companion so its Space-backed support workspace is
/// available on a fresh install. Rebuild with `bun run --cwd apps-store/help-center/ui
/// build` (or `scripts/sync-app-fixtures.sh help-center`) and copy `dist/index.html` to
/// `fixtures/help-center.ui.html` to refresh it.
pub const HELP_CENTER_UI_HTML: &str = include_str!("fixtures/help-center.ui.html");
/// Sites prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/sites/ui`, all JS/CSS inlined).
/// Seeded as the first-party companion so the wildcard public-edge control
/// surface is available on a fresh install. Rebuild with
/// `bun run --cwd apps-store/sites/ui build` (or
/// `scripts/sync-app-fixtures.sh sites`) and copy `dist/index.html` to
/// `fixtures/sites.ui.html` to refresh it.
pub const SITES_UI_HTML: &str = include_str!("fixtures/sites.ui.html");

/// Forms ships its checked-in Companion bundle with the sidecar satellite. Core
/// carries only the bundle needed for its generic built-in app install path.
pub const FORMS_UI_HTML: &str =
    include_str!("../../../../generated/ryu-runtime/apps-store/forms/sidecar/bundle/index.html");

/// The Bot Flows app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/bot-flows/ui`, all JS/CSS inlined).
/// Seeded through the generic opt-in install path; the flow builder, public chat
/// pages, and conversation store live in the satellite. Refresh it with
/// `scripts/sync-app-fixtures.sh bot-flows`; never hand-edit it.
pub const BOT_FLOWS_UI_HTML: &str = include_str!("fixtures/bot-flows.ui.html");

/// The Chat Broadcast app's prebuilt, self-contained UI bundle. The app is
/// desktop-only and sends through the trusted host bridge; it has no sidecar or
/// public HTTP surface. Rebuild with `bun run --cwd apps-store/chat-broadcast/ui
/// build` and copy `dist/index.html` to `ui/companion.html` to refresh it.
pub const CHAT_BROADCAST_UI_HTML: &str =
    include_str!("../../../../generated/ryu-runtime/apps-store/chat-broadcast/ui/companion.html");

/// The Warmup app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/warmup/ui`, all JS/CSS — incl. the tree-shaken `@ryu/ui`
/// components — inlined). Seeded as the plugin's `ui_code` onto a DISABLED record,
/// so enabling the opt-in `@ryu/warmup` app from the store mounts the sandboxed
/// companion. Rebuild with `bun run --cwd apps-store/warmup/ui build` (or
/// `scripts/sync-app-fixtures.sh warmup`) and copy `dist/index.html` to
/// `fixtures/warmup.ui.html` to refresh it.
pub const WARMUP_UI_HTML: &str = include_str!("fixtures/warmup.ui.html");

/// The Learning app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/learning/ui`, all JS/CSS — incl. the tree-shaken `@ryu/ui`
/// components — inlined). Seeded as the plugin's `ui_code` (pre-installed companion) so
/// the `/learning` route mounts the sandboxed companion. The `@ryu/learning`
/// manifest was a wave-2 route-gate governance shell (gating `/api/learn/*` +
/// `/api/experience/*`); the W7 frontend extraction upgrades it in place to ALSO
/// carry the companion runnable. Rebuild with `bun run --cwd apps-store/learning/ui
/// build` (or `scripts/sync-app-fixtures.sh learning`) and copy `dist/index.html` to
/// `fixtures/learning.ui.html` to refresh it.
pub const LEARNING_UI_HTML: &str = include_str!("fixtures/learning.ui.html");

/// The Meetings app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `apps-store/meetings/ui`, all JS/CSS — incl. the tree-shaken `@ryu/ui`
/// components — inlined). Seeded as the plugin's `ui_code` (pre-installed companion) so
/// the `/meetings` + `/meetings/:id` routes mount the sandboxed companion (record →
/// live transcript → AI notes + audio import). The `@ryu/meetings` manifest was a
/// wave-2 route-gate governance shell (gating `/api/meetings/*`) that `requires` the
/// `spaces` app; the W7 frontend extraction upgrades it in place to ALSO carry the
/// companion runnable. Rebuild with `bun run --cwd apps-store/meetings/ui build` (or
/// `scripts/sync-app-fixtures.sh meetings`) and copy `dist/index.html` to
/// `fixtures/meetings.ui.html` to refresh it.
pub const MEETINGS_UI_HTML: &str = include_str!("fixtures/meetings.ui.html");

/// The Outpost (social) app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/social/ui`, all JS/CSS — incl. the
/// tree-shaken `@ryu/ui` components — inlined). Seeded as the plugin's `ui_code` onto
/// a DISABLED record, so enabling the opt-in `@ryu/social` app from the store mounts
/// the sandboxed companion on `/social` + `/social/:id` (compose → calendar → queue →
/// inbox). The frame reaches its own `ryu-social` sidecar ONLY through the
/// `social:crud` bridge forwarder — its CSP is `connect-src 'none'` and it declares no
/// `csp` widening, so it has no network of its own. Rebuild with
/// `bun run --cwd apps-store/social/ui build` (or `scripts/sync-app-fixtures.sh
/// social`) and copy `dist/index.html` to `fixtures/social.ui.html` to refresh it.
pub const SOCIAL_UI_HTML: &str = include_str!("fixtures/social.ui.html");

/// The Deep Read (`@ryu/rlm`) app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/rlm/ui`, all JS/CSS inlined).
/// Seeded as the plugin's `ui_code` onto a DISABLED record, so enabling the opt-in
/// `@ryu/rlm` app from the store mounts the sandboxed companion (load a corpus →
/// outline → ask → trace). The frame reaches its own `ryu-rlm` sidecar ONLY through
/// the `rlm:query` bridge forwarder — its CSP is `connect-src 'none'` and it
/// declares no `csp` widening, so it has no network of its own. Rebuild with
/// `bun run --cwd apps-store/rlm/ui build` (or `scripts/sync-app-fixtures.sh rlm`)
/// and copy `dist/index.html` to `fixtures/rlm.ui.html` to refresh it.
pub const RLM_UI_HTML: &str = include_str!("fixtures/rlm.ui.html");

/// The Clips app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/clips/ui`, all JS/CSS and the
/// local demo media asset inlined). It is attached on explicit install through the
/// generic companion table; the frame reaches its own sidecar through `app:http`.
/// Rebuild with `bun run --cwd apps-store/clips/ui build` (or
/// `scripts/sync-app-fixtures.sh clips`) and refresh `fixtures/clips.ui.html`.
pub const CLIPS_UI_HTML: &str = include_str!("fixtures/clips.ui.html");

/// The Subtitles app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/subtitles/ui`, all JS/CSS — incl.
/// the tree-shaken `@ryu/ui` components — inlined). Seeded as the plugin's `ui_code`
/// onto a DISABLED record, so enabling the opt-in `@ryu/subtitles` app from the store
/// mounts the sandboxed companion on `/subtitles` + `/subtitles/:id` (pick a video →
/// watch the job → read the transcript). The frame reaches its own `ryu-subtitles`
/// sidecar ONLY through the `subtitles:crud` bridge forwarder — its CSP is
/// `connect-src 'none'` and it declares no `csp` widening, so it has no network of its
/// own, and the video it names is opened by the SIDECAR rather than uploaded through
/// the frame. Rebuild with `bun run --cwd apps-store/subtitles/ui build` (or
/// `scripts/sync-app-fixtures.sh subtitles`) and copy `dist/index.html` to
/// `fixtures/subtitles.ui.html` to refresh it.
pub const SUBTITLES_UI_HTML: &str = include_str!("fixtures/subtitles.ui.html");

/// The Inbox (Approvals) app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `apps-store/approvals/ui`, all JS/CSS — incl. the
/// tree-shaken `@ryu/ui` components — inlined). Seeded as the plugin's `ui_code`
/// (pre-installed companion) so the `/inbox` + `/approvals` routes mount the sandboxed
/// companion. The `@ryu/approvals` manifest was a wave-2 gate-only governance shell
/// (gating `/api/approvals/*`); the W7 frontend extraction upgrades it in place to ALSO
/// carry the companion runnable — the unified Inbox page (approvals + notifications +
/// quest check-offs + Shadow suggestions). Rebuild with
/// `bun run --cwd apps-store/approvals/ui build` (or `scripts/sync-app-fixtures.sh
/// approvals`) and copy `dist/index.html` to `fixtures/approvals.ui.html` to refresh it.
pub const APPROVALS_UI_HTML: &str = include_str!("fixtures/approvals.ui.html");

/// Loader that merges built-in manifests with user-installed ones from
/// `~/.ryu/plugins/*/manifest.json` (the path is overridable via `RYU_PLUGINS_DIR`,
/// or the legacy `RYU_APPS_DIR`; the legacy `plugin.json` and `ryu.json` file names
/// are also read).
///
/// # Validation
/// - A manifest whose `version` field is not valid semver is rejected with a logged
///   warning; all other manifests continue loading.
/// - A duplicate `id` (across built-ins and user manifests) is rejected with a
///   logged warning; the *first* manifest with that id wins.
/// - Any manifest that fails JSON parsing is skipped with a warning.
pub struct PluginManifestLoader;

/// A manifest that parsed and validated cleanly but whose declared **host floors**
/// (`engines`) this node does not satisfy.
///
/// ## Why the manifest is private
///
/// An incompatible plugin has to be VISIBLE (the marketplace must show it, greyed,
/// saying what it needs) without being LIVE. Those pull in opposite directions: the
/// moment an incompatible manifest reaches the runtime manifest list, every
/// consumer that iterates it picks the plugin up — hook dispatch, `app_contrib`,
/// `may_emit_event`, the contributions endpoint, sidecar spawn, `http.public_mount`,
/// `AppGate` registration. Auditing all of them to skip one flag is exactly the kind
/// of "one site missed it" bug this codebase already learned about with legacy id
/// canonicalization.
///
/// So the manifest is not exposed as a field. [`PluginManifestLoader::load`] still
/// returns `Vec<PluginManifest>` containing ONLY compatible manifests — every
/// existing runtime caller is unchanged and cannot see an incompatible plugin even
/// in principle. The catalog projection is the one consumer that wants it, and it
/// asks by name via [`IncompatibleManifest::for_catalog`].
#[derive(Debug, Clone)]
pub struct IncompatibleManifest {
    /// PRIVATE by design — see the type doc. Reach it via
    /// [`IncompatibleManifest::for_catalog`], which names its one legitimate use.
    manifest: PluginManifest,
    /// Which floors are unsatisfied, and what is actually running.
    verdict: CompatibilityVerdict,
    /// Where this manifest came from (`<built-in>` or a path), for diagnostics.
    source: String,
}

impl IncompatibleManifest {
    /// The plugin id.
    pub fn id(&self) -> &str {
        &self.manifest.id
    }

    /// Why it is incompatible.
    pub fn verdict(&self) -> &CompatibilityVerdict {
        &self.verdict
    }

    /// Where it was loaded from.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// The manifest, **for building a marketplace card only**.
    ///
    /// Named for its one legitimate caller so that any other use is obvious in
    /// review. Do NOT register hooks, routes, sidecars, contributions or public
    /// mounts from this — the plugin is not installable on this node, and anything
    /// it registers is a capability the user cannot see or govern.
    pub fn for_catalog(&self) -> &PluginManifest {
        &self.manifest
    }
}

/// The outcome of a load pass: the manifests that may run, and the ones that may
/// only be shown.
#[derive(Debug, Clone, Default)]
pub struct LoadedManifests {
    /// Manifests that passed every gate. This is what the runtime uses.
    pub compatible: Vec<PluginManifest>,
    /// Manifests held back by an unsatisfied host floor. Catalog-only.
    pub incompatible: Vec<IncompatibleManifest>,
}

/// Why a manifest did not make it into the runtime set.
///
/// Split so the loader can tell "this file is broken, drop it" (the historical
/// behaviour, still a warning) apart from "this plugin is fine but needs a newer
/// host", which is a first-class, user-facing state rather than a log line.
#[derive(Debug, Clone)]
pub enum ManifestRejection {
    /// Malformed, unparseable, duplicate, or otherwise invalid. Dropped entirely.
    Invalid(String),
    /// Well-formed, but this node does not meet its declared host floors.
    Incompatible(Box<IncompatibleManifest>),
}

/// Every pre-existing gate in `parse_and_validate` reports a `String`, and all of
/// them mean the same thing: this manifest is not usable. Converting here keeps
/// those call sites (and their `?`) untouched, so the only gate that had to learn
/// the new outcome is the host-floor one.
impl From<String> for ManifestRejection {
    fn from(msg: String) -> Self {
        ManifestRejection::Invalid(msg)
    }
}

impl std::fmt::Display for ManifestRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ManifestRejection::Invalid(msg) => f.write_str(msg),
            ManifestRejection::Incompatible(inc) => {
                let unmet: Vec<String> = inc
                    .verdict
                    .unmet
                    .iter()
                    .filter(|u| u.is_blocking())
                    .map(|u| match u {
                        UnmetRequirement::TooOld {
                            surface,
                            required,
                            present,
                        } => format!(
                            "{} requires {required} but this node has {present}",
                            surface.engines_key()
                        ),
                        UnmetRequirement::InvalidRequirement {
                            surface, required, ..
                        } => format!(
                            "{} has an invalid requirement '{required}'",
                            surface.engines_key()
                        ),
                        UnmetRequirement::Unknown { surface, required } => {
                            format!(
                                "{} requires {required} (version unknown)",
                                surface.engines_key()
                            )
                        }
                        UnmetRequirement::HostApiTooOld {
                            required, present, ..
                        } => format!(
                            "host_api requires {required} but this node serves host API {present}"
                        ),
                    })
                    .collect();
                write!(
                    f,
                    "app '{}' is not compatible with this node: {} (source: {})",
                    inc.manifest.id,
                    unmet.join("; "),
                    inc.source
                )
            }
        }
    }
}

/// The host versions this node can actually vouch for.
///
/// Core knows its own version, and the Gateway's when it has been observed via
/// `/health`. Everything else — desktop, island, mobile, extension, web, and a
/// separately-installed CLI — is a distinct install that never reports in, so it is
/// deliberately absent rather than guessed. Absent means UNKNOWN, which
/// [`HostVersions::evaluate`] treats as advisory: see
/// [`UnmetRequirement::Unknown`].
///
/// Guessing here would be the dangerous choice. Core, Gateway, CLI and desktop do
/// ship from one release train, so stamping Core's version onto all four would
/// usually be right — and silently wrong exactly when it matters, for the stale
/// binary left behind by a partial update, which is the case a floor exists to
/// catch.
pub fn node_host_versions() -> HostVersions {
    let mut hosts = HostVersions::default().with(Surface::Core, core_version().to_string());
    if let Some(gw) = crate::sidecar::gateway::observed_gateway_version() {
        hosts = hosts.with(Surface::Gateway, gw);
    }
    hosts
}

impl PluginManifestLoader {
    /// Resolve the plugins scan directory.
    ///
    /// Resolution order:
    /// 1. `RYU_PLUGINS_DIR` if set.
    /// 2. `RYU_APPS_DIR` if set (legacy env var, still honoured).
    /// 3. `<data dir>/plugins`.
    pub fn plugins_dir() -> PathBuf {
        if let Some(p) = std::env::var_os("RYU_PLUGINS_DIR") {
            return PathBuf::from(p);
        }
        if let Some(p) = std::env::var_os("RYU_APPS_DIR") {
            return PathBuf::from(p);
        }
        ryu_sidecar_runtime::layout::plugins_dir(&crate::paths::ryu_dir())
    }

    /// Load all manifests: built-ins first, then user-installed. Returns only
    /// the manifests that pass semver and duplicate-id validation.
    ///
    /// **Compatible manifests only.** A plugin whose host floors this node does not
    /// meet is not in this list — which is precisely how the runtime is kept from
    /// ever activating one. Callers that need to SHOW those (the catalog) use
    /// [`Self::load_all`] and read the [`LoadedManifests::incompatible`] lane.
    pub fn load() -> Vec<PluginManifest> {
        Self::load_all().compatible
    }

    /// Load the manifests that are allowed to run in the active runtime.
    ///
    /// Runtime consumers receive explicit system manifests, Core-mandatory
    /// manifests, and packages present in the user's plugin directory. Official
    /// marketplace listings are catalog metadata, not runtime registrations.
    pub fn load_runtime() -> Vec<PluginManifest> {
        Self::load_runtime_from(&Self::plugins_dir())
    }

    fn load_runtime_from(dir: &Path) -> Vec<PluginManifest> {
        let mut manifests = Vec::new();
        let mut seen_ids = HashSet::new();

        // System sidecars and mandatory in-process capabilities must exist before
        // marketplace materialization. In particular, Spaces is a Core-owned
        // fixture with no satellite package; excluding mandatory manifests here
        // leaves its route gate permanently disabled on a fresh node.
        for manifest in Self::load_builtins()
            .into_iter()
            .filter(|manifest| crate::plugins::builtins::is_runtime_builtin(&manifest.id))
        {
            seen_ids.insert(manifest.id.clone());
            manifests.push(manifest);
        }

        // Installed packages are parsed from disk and therefore take the
        // runtime slot for ordinary plugins, even when the catalog index still
        // contains a compiled copy for discovery.
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return manifests;
        };
        // Filesystem order is not stable (NTFS is alphabetical, ext4 hash-based),
        // and a package's id names its directory; sort so which duplicate wins
        // never depends on the volume.
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let Some(manifest_path) = MANIFEST_FILE_NAMES
                .iter()
                .map(|name| entry.path().join(name))
                .find(|path| path.exists())
            else {
                continue;
            };
            let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
                tracing::warn!(
                    "could not read installed plugin manifest {}",
                    manifest_path.display()
                );
                continue;
            };
            let raw = match Self::translate_agent_plugin(&raw, &manifest_path) {
                Ok(raw) => raw,
                Err(error) => {
                    tracing::warn!(
                        "installed plugin {} skipped: {error}",
                        manifest_path.display()
                    );
                    continue;
                }
            };
            match Self::parse_and_validate(
                &raw,
                &manifest_path.to_string_lossy(),
                manifest_path.parent(),
                &mut seen_ids,
            ) {
                Ok(manifest) => manifests.push(manifest),
                Err(error) => tracing::warn!("installed plugin skipped: {error}"),
            }
        }
        manifests
    }

    /// [`Self::load`] plus the manifests held back by an unsatisfied host floor.
    ///
    /// Only the catalog projection should call this. Everything that RUNS a plugin
    /// wants `load()`, whose type makes the incompatible lane unreachable.
    pub fn load_all() -> LoadedManifests {
        let mut manifests: Vec<PluginManifest> = Vec::new();
        let mut incompatible: Vec<IncompatibleManifest> = Vec::new();
        let mut seen_ids: HashSet<String> = HashSet::new();

        // 1. Built-in manifests (compiled in).
        for &raw in BUILTIN_MANIFESTS {
            match Self::parse_and_validate(raw, "<built-in>", None, &mut seen_ids) {
                Ok(m) => manifests.push(m),
                Err(ManifestRejection::Incompatible(inc)) => {
                    tracing::info!(
                        plugin = %inc.id(),
                        "built-in held back: {}",
                        ManifestRejection::Incompatible(inc.clone())
                    );
                    incompatible.push(*inc);
                }
                Err(e) => tracing::warn!("built-in manifest skipped: {e}"),
            }
        }

        // 2. User-installed manifests from the plugins directory. Each plugin dir
        //    may carry `manifest.json` (preferred) or the legacy `plugin.json` /
        //    `ryu.json`.
        let dir = Self::plugins_dir();
        match std::fs::read_dir(&dir) {
            Ok(entries) => {
                // Sorted for the same reason as in `load_runtime_from`: the load
                // order must not be whatever the filesystem happens to return.
                let mut entries: Vec<_> = entries.flatten().collect();
                entries.sort_by_key(std::fs::DirEntry::file_name);
                for entry in entries {
                    let Some(manifest_path) = MANIFEST_FILE_NAMES
                        .iter()
                        .map(|name| entry.path().join(name))
                        .find(|p| p.exists())
                    else {
                        continue;
                    };
                    match std::fs::read_to_string(&manifest_path) {
                        Ok(raw) => {
                            // `plugin.json` is BOTH a legacy alias for our own
                            // manifest and the Agent Plugins spec's manifest name.
                            // A spec file declares the canonical agent-plugins.org
                            // `$schema`, which no native manifest has ever carried;
                            // translate it before the native parser sees a file with
                            // no `id`/`runnables` and rejects the plugin.
                            let raw = match Self::translate_agent_plugin(&raw, &manifest_path) {
                                Ok(translated) => translated,
                                Err(e) => {
                                    tracing::warn!(
                                        "agent plugin at {} skipped: {e}",
                                        manifest_path.display()
                                    );
                                    continue;
                                }
                            };
                            match Self::parse_and_validate(
                                &raw,
                                &manifest_path.to_string_lossy(),
                                manifest_path.parent(),
                                &mut seen_ids,
                            ) {
                                Ok(m) => manifests.push(m),
                                Err(ManifestRejection::Incompatible(inc)) => {
                                    tracing::info!(
                                        plugin = %inc.id(),
                                        "installed plugin held back: {}",
                                        ManifestRejection::Incompatible(inc.clone())
                                    );
                                    incompatible.push(*inc);
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        "plugin manifest at {} skipped: {e}",
                                        manifest_path.display()
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            tracing::warn!(
                                "could not read plugin manifest at {}: {e}",
                                manifest_path.display()
                            );
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::debug!(
                    "plugins directory {} does not exist; no user plugins loaded",
                    dir.display()
                );
            }
            Err(e) => {
                tracing::warn!("could not scan plugins directory {}: {e}", dir.display());
            }
        }

        LoadedManifests {
            compatible: manifests,
            incompatible,
        }
    }

    /// Parse the compiled Core system manifests, ignoring `~/.ryu/plugins`.
    ///
    /// Parse ONLY the compiled-in system manifests, synchronously and with no disk
    /// scan (unlike [`Self::load`], which also reads the user plugins directory). Two
    /// callers: hermetic built-in tests (a `load()`-based assertion would also depend
    /// on whatever the developer has installed locally), and router-build-time
    /// public-mount registration (which is built-in-only by design and must be sync).
    pub(crate) fn load_builtins() -> Vec<PluginManifest> {
        let mut seen_ids: HashSet<String> = HashSet::new();
        BUILTIN_MANIFESTS
            .iter()
            .filter_map(|raw| Self::parse_and_validate(raw, "<built-in>", None, &mut seen_ids).ok())
            .collect()
    }

    /// Parse every compiled manifest available to the local plugin Store.
    ///
    /// Runtime startup deliberately uses `load_builtins()` instead, so opt-in
    /// packages are not active or discoverable as installed until the user
    /// persists them through the normal lifecycle.
    pub(crate) fn load_install_catalog() -> Vec<PluginManifest> {
        let mut seen_ids: HashSet<String> = HashSet::new();
        CORE_RUNTIME_BUILTIN_MANIFESTS
            .iter()
            .chain(CORE_INSTALLABLE_BUILTIN_MANIFESTS.iter())
            .filter_map(|raw| {
                Self::parse_and_validate(raw, "<built-in install catalog>", None, &mut seen_ids)
                    .ok()
            })
            .collect()
    }

    /// Recover a missing source directory for an exact compiled install-catalog
    /// plugin. Third-party plugins still need to carry their package files or a
    /// source archive; this only projects first-party assets embedded in Core.
    pub(crate) fn materialize_builtin_plugin_source(
        package_root: &Path,
        source_path: &str,
    ) -> Result<bool, String> {
        builtin_plugin_assets::ensure_compiled_source(
            package_root,
            &Self::plugins_dir(),
            source_path,
        )
    }

    /// Parse the production runtime fixture set even in test builds. This keeps
    /// seed-order tests honest: the hermetic test catalog intentionally has more
    /// fixtures than a release Core binary, while pre-installed reachability
    /// depends on the smaller production set.
    #[cfg(test)]
    pub(crate) fn load_runtime_builtins_for_test() -> Vec<PluginManifest> {
        let mut seen_ids: HashSet<String> = HashSet::new();
        CORE_RUNTIME_BUILTIN_MANIFESTS
            .iter()
            .filter_map(|raw| Self::parse_and_validate(raw, "<built-in>", None, &mut seen_ids).ok())
            .collect()
    }

    /// Return only the Core-owned manifests from the compiled index.
    pub(crate) fn load_system_builtins() -> Vec<PluginManifest> {
        Self::load_builtins()
            .into_iter()
            .filter(|manifest| crate::plugins::builtins::is_system_plugin(&manifest.id))
            .collect()
    }

    /// Combine the manifests available before the HTTP listener starts.
    /// Installed/runtime manifests win over compiled declarations so a
    /// materialized package's current manifest is used for its public mount.
    /// Compiled first-party manifests that are opt-in still contribute their
    /// declared public mounts: the router is immutable after bind, while the
    /// enabled gate in the generic proxy keeps an uninstalled app's prefix inert.
    ///
    /// (A separate bootstrap manifest list used to feed this for Core's per-app
    /// loopback clients; it emptied with the last one, `healing_client.rs`, and was
    /// deleted, per `docs/app-boundary-extraction-plan.md` step 8.)
    pub(crate) fn for_router(installed: &[PluginManifest]) -> Vec<PluginManifest> {
        let mut manifests = installed.to_vec();
        let mut seen_ids: HashSet<String> = installed.iter().map(|m| m.id.clone()).collect();
        // Public mounts are stable routes owned by compiled first-party manifests.
        // Include only manifests that declare one; ordinary opt-in built-ins remain
        // absent from the router snapshot, but an app such as Rooms must have its
        // guest prefix registered before a later runtime install can enable it.
        manifests.extend(
            Self::load_builtins()
                .into_iter()
                .filter(|manifest| {
                    manifest.sidecars.iter().any(|sidecar| {
                        sidecar
                            .http
                            .as_ref()
                            .is_some_and(|http| http.public_mount.is_some())
                    })
                })
                .filter(|manifest| seen_ids.insert(manifest.id.clone())),
        );
        manifests
    }

    /// Translate an Agent Plugins v1 manifest into the native form, or pass a
    /// native manifest through untouched.
    ///
    /// Import is deliberately a translation in FRONT of the normal loader rather
    /// than a second loader: everything Core enforces on a manifest — id
    /// validation, legacy-id canonicalization, semver, duplicate-id rejection —
    /// then applies to an imported plugin too, because it takes the identical
    /// path. See [`agent_plugin`] for the spec rules and the security posture.
    fn translate_agent_plugin(raw: &str, path: &Path) -> Result<String, String> {
        if !agent_plugin::is_agent_plugin_manifest(raw) {
            return Ok(raw.to_string());
        }
        let dir = path
            .parent()
            .ok_or_else(|| "manifest has no parent directory".to_string())?;
        let imported = agent_plugin::import_manifest(dir, raw)?;
        for note in &imported.notes {
            // The spec requires a client to REPORT what it skipped or ignored
            // (§6.2, §7.2.2) rather than fail, so these are warnings by contract.
            tracing::warn!("agent plugin {}: {note}", path.display());
        }
        serde_json::to_string(&imported.manifest)
            .map_err(|e| format!("could not serialize translated manifest: {e}"))
    }

    /// Parse one manifest and run Core's full load-time gate over it.
    ///
    /// `code_base` is where this manifest's `code_file` references resolve from:
    /// `None` for a compiled-in built-in (they come from the embedded
    /// [`builtin_code`] table) and `Some(plugin_dir)` for a manifest read off disk.
    /// Hydration runs FIRST, before any other gate, so every later check — and every
    /// consumer — sees the runtime-ready form with `code` populated.
    fn parse_and_validate(
        raw: &str,
        source: &str,
        code_base: Option<&Path>,
        seen_ids: &mut HashSet<String>,
    ) -> Result<PluginManifest, ManifestRejection> {
        let mut manifest: PluginManifest =
            serde_json::from_str(raw).map_err(|e| format!("JSON parse error: {e}"))?;

        validate_plugin_id(&manifest.id).map_err(|e| format!("{e} (source: {source})"))?;

        // Canonicalize a legacy id to its scoped form HERE — the single load
        // chokepoint — so nothing downstream needs alias awareness. `app_store`
        // lookups, hook dispatch, `may_emit_event`, the contributions endpoint and
        // every `manifests.iter().find(|m| m.id == ...)` then only ever compare
        // canonical ids. Sprinkling `canonical_plugin_id` at read sites instead is
        // how one site ends up missing it and silently resolving nothing.
        //
        // Deliberately AFTER validation: an id is validated in the exact form the
        // author wrote, so a malformed legacy id cannot be laundered by an alias.
        let canonical = canonical_plugin_id(&manifest.id);
        if canonical != manifest.id {
            tracing::debug!(
                legacy = %manifest.id,
                canonical,
                "plugin_manifest: canonicalized a legacy plugin id"
            );
            manifest.id = canonical.to_owned();
        }

        // Dependency edges name OTHER plugins, so they need the same treatment: a
        // manifest that says `requires.apps: [{ id: "@ryu/ghost" }]` must still resolve
        // after ghost became `@ryu/ghost`, or the dependency graph reports a missing
        // dependency and refuses to enable the plugin. Applies to third-party
        // manifests that will never be updated, which is the whole point of the map.
        if let Some(requires) = manifest.requires.as_mut() {
            for dep in &mut requires.apps {
                let canonical = canonical_plugin_id(&dep.id);
                if canonical != dep.id {
                    dep.id = canonical.to_owned();
                }
            }
        }

        hydrate_manifest_code_files(&mut manifest, code_base)
            .map_err(|e| format!("{e} (source: {source})"))?;

        if semver::Version::parse(&manifest.version).is_err() {
            return Err(format!(
                "app '{}' has invalid semver version '{}' (source: {source})",
                manifest.id, manifest.version
            )
            .into());
        }

        if !seen_ids.insert(manifest.id.clone()) {
            return Err(format!(
                "duplicate app id '{}' (source: {source}); first occurrence wins",
                manifest.id
            )
            .into());
        }

        // Host-floor gate: every requirement in `engines` must parse as semver, and
        // every floor for a surface whose version this node KNOWS must be satisfied.
        //
        // The two failures are deliberately different outcomes:
        //
        //   * an UNPARSEABLE requirement is a broken manifest — a hard `Invalid`,
        //     dropped exactly as before. There is nothing to show a user, and a
        //     requirement nobody can evaluate must never be treated as satisfied.
        //   * an UNSATISFIED floor is a well-formed plugin that this node is too old
        //     to run. That used to be a hard reject too, which made the plugin
        //     VANISH: no card, no explanation, no way for a user to learn that
        //     updating would bring it back. It now goes to the incompatible lane —
        //     shown in the marketplace with what it needs, refused at install.
        //
        // Only floors for OBSERVABLE surfaces can block; see `node_host_versions`.
        if let Some(engines) = &manifest.engines {
            let verdict = node_host_versions().evaluate(Some(engines));
            if let Some(bad) = verdict.unmet.iter().find_map(|u| match u {
                UnmetRequirement::InvalidRequirement {
                    surface,
                    required,
                    reason,
                } => Some((surface, required, reason)),
                _ => None,
            }) {
                let (surface, required, reason) = bad;
                // `host_api_unmet` tags its reason with the key it came from, since
                // the host API floor is reported against the Core surface.
                let key = if reason.starts_with("engines.host_api") {
                    "host_api"
                } else {
                    surface.engines_key()
                };
                return Err(ManifestRejection::Invalid(format!(
                    "app '{}' has an invalid engines.{key} requirement '{required}': {reason} \
                     (source: {source})",
                    manifest.id,
                )));
            }
            if !verdict.compatible {
                return Err(ManifestRejection::Incompatible(Box::new(
                    IncompatibleManifest {
                        manifest,
                        verdict,
                        source: source.to_owned(),
                    },
                )));
            }
        }

        // Dependency SHAPE gate (`requires.apps`). This is deliberately per-manifest
        // only — self-dependency, a malformed `min_version`, and duplicate edges are
        // all decidable from this manifest alone. Whether a declared dependency
        // EXISTS, is version-SATISFIABLE, and is ACYCLIC are cross-manifest
        // questions that this function structurally cannot answer (it sees one
        // manifest and a `seen_ids` set, never the other 36); those resolve later
        // against the full installed set in `crate::plugins::graph`.
        {
            let mut seen_deps: HashSet<&str> = HashSet::new();
            for dep in manifest.dependencies() {
                validate_plugin_id(&dep.id).map_err(|e| {
                    format!(
                        "app '{}' declares dependency with invalid id: {e} (source: {source})",
                        manifest.id
                    )
                })?;
                if dep.id == manifest.id {
                    return Err(format!(
                        "app '{}' cannot depend on itself (source: {source})",
                        manifest.id
                    )
                    .into());
                }
                if !seen_deps.insert(dep.id.as_str()) {
                    return Err(format!(
                        "app '{}' declares duplicate dependency '{}' (source: {source})",
                        manifest.id, dep.id
                    )
                    .into());
                }
                if let Some(min) = &dep.min_version {
                    parse_min_version(min).map_err(|e| {
                        format!(
                            "app '{}' dependency '{}': {e} (source: {source})",
                            manifest.id, dep.id
                        )
                    })?;
                }
            }
        }

        // Validate each Runnable's per-kind config contract.
        for entry in &manifest.runnables {
            validate_runnable(entry)
                .map_err(|e| format!("app '{}' (source: {source}): {e}", manifest.id))?;
            // The pre-rename backend name still loads (as `inline_js`); tell the
            // author so it gets renamed before the alias goes away.
            if schema::runnable_uses_legacy_inline_deno(entry) {
                warn_legacy_inline_deno_once(&manifest.id, &entry.id, source);
            }
        }

        // Validate each declared managed sidecar (name safety, health path, and
        // per-process-kind required fields). Duplicate local names would collide on
        // the same `<plugin_id>/<name>` manager key, so reject them at load.
        {
            let mut seen: HashSet<&str> = HashSet::new();
            for spec in &manifest.sidecars {
                crate::plugin_manifest::schema::validate_sidecar_spec(spec)
                    .map_err(|e| format!("app '{}' (source: {source}): {e}", manifest.id))?;
                if !seen.insert(spec.name.as_str()) {
                    return Err(format!(
                        "app '{}' declares duplicate sidecar name '{}' (source: {source})",
                        manifest.id, spec.name
                    )
                    .into());
                }
            }
        }

        // Manifest-level companion surface: anti-impersonation on the visible label
        // (same rule as the companion *runnable* config and the desktop route-title
        // gate) so a plugin's panel can never pose as first-party Ryu/system chrome.
        if let Some(companion) = &manifest.companion {
            if companion.label.trim().is_empty() {
                return Err(format!(
                    "app '{}' companion label must not be empty (source: {source})",
                    manifest.id
                )
                .into());
            }
            if crate::plugin_manifest::schema::label_impersonates_system_chrome(&companion.label) {
                return Err(format!(
                    "app '{}' companion label '{}' must not impersonate system chrome (must not contain 'ryu' or 'system') (source: {source})",
                    manifest.id, companion.label
                ).into());
            }
        }

        // Contribution cross-validation: every id referenced in `contributes`
        // must resolve to a runnable declared in this manifest (declare-by-id).
        if let Some(contributes) = &manifest.contributes {
            let runnable_ids: HashSet<&str> =
                manifest.runnables.iter().map(|r| r.id.as_str()).collect();
            for referenced in contributes.referenced_ids() {
                if !runnable_ids.contains(referenced) {
                    return Err(format!(
                        "app '{}' contributes unknown runnable id '{referenced}' (no matching entry in 'runnables') (source: {source})",
                        manifest.id
                    ).into());
                }
            }
        }

        // Universal declarative-HTTP gate. Provenance is not available at this
        // first load seam (the plugin store rehydrates it later), so ownership is
        // enforced at install + contributions serialization. What is decidable
        // here is still security-critical: safe Core-relative paths, known action
        // methods, and GET-only automatic sources.
        manifest
            .validate_declarative_http_policy(true)
            .map_err(|e| format!("{e} (source: {source})"))?;

        // Settings + tool-filter schema gate — the manifest equivalent of parsing a
        // config through a schema at import instead of trusting it at use.
        //
        // `settings_tabs` is stored as raw JSON so the contributions endpoint can tag
        // and forward each entry verbatim (see `Contributes::settings_tabs`), so it is
        // only ever held to `SettingsTabContribution` at a validation chokepoint —
        // and this is Core's, covering compiled-in built-ins and disk-loaded
        // third-party manifests alike because every manifest reaches Core through
        // this function. Without it a malformed tab travels all the way to the
        // desktop and is dropped by the renderer's defensive parser: the author sees
        // a settings screen with a missing row and no diagnostic anywhere. The rules
        // themselves live in the contract crate so the SDK/FFI path
        // (`PluginManifest::validate`) enforces exactly the same ones. A failure here
        // is a skipped manifest with a warn, same as every other gate above.
        if let Some(contributes) = &manifest.contributes {
            contributes
                .validate_settings_contributions()
                .map_err(|e| format!("app '{}': {e} (source: {source})", manifest.id))?;
            contributes
                .validate_companion_references(&manifest.runnables)
                .map_err(|e| format!("app '{}': {e} (source: {source})", manifest.id))?;

            // Output styles need their own line here for the reason this loader
            // re-runs individual gates rather than `PluginManifest::validate`:
            // hydration above already enforced exactly-one-of `source`/`file`, the
            // path allowlist and the size cap, but NOT the id alphabet or id
            // uniqueness. A duplicate id is the one that has to be caught at load —
            // two rows sharing one id collapse to a single entry in the merged
            // registry, so an agent's persisted profile reference silently resolves
            // to whichever happened to load last. Runs AFTER hydration on purpose: by now every
            // row is in the `source`-only wire form the check's second arm accepts.
            contributes
                .validate_output_styles()
                .map_err(|e| format!("app '{}': {e} (source: {source})", manifest.id))?;
            contributes
                .validate_backgrounds(&manifest.id)
                .map_err(|e| format!("app '{}': {e} (source: {source})", manifest.id))?;
            contributes
                .validate_avatar_contributions(&manifest.id)
                .map_err(|e| format!("app '{}': {e} (source: {source})", manifest.id))?;
        }

        // User-facing permission vocabulary gate. Repeated here rather than inherited
        // from `PluginManifest::validate` because this loader deliberately re-runs the
        // individual gates instead of the whole superset — the ids become grant
        // strings and API path segments, so a malformed one must never reach storage.
        validate_permission_levels(&manifest.permission_levels)
            .map_err(|e| format!("app '{}': {e} (source: {source})", manifest.id))?;
        validate_levels_stay_out_of_kernel(&manifest.permission_levels)
            .map_err(|e| format!("app '{}': {e} (source: {source})", manifest.id))?;

        // Browser cookies are stripped from proxy hops by default. A sidecar may
        // opt into only its own namespaced HttpOnly session cookies; validate this
        // at load so an unsafe declaration never reaches the forwarding path.
        ryu_kernel_contracts::manifest::validate_forwarded_cookie_names(
            &manifest.id,
            &manifest.sidecars,
        )
        .map_err(|e| format!("app '{}': {e} (source: {source})", manifest.id))?;

        // And the routes that CONSUME that vocabulary. Load-time rather than
        // call-time because a route naming an undeclared level is unsatisfiable: the
        // ext-proxy would refuse it on every request with the cause visible only in
        // whatever the resolver logs.
        validate_route_permissions(&manifest.sidecars, &manifest.permission_levels)
            .map_err(|e| format!("app '{}': {e} (source: {source})", manifest.id))?;

        Ok(manifest)
    }
}

/// Refuse an app-owned permission level that implies a kernel key.
///
/// [`validate_permission_levels`] only requires an implied id to be declared in
/// the same manifest, and a manifest may declare a kernel key (`space.delete`,
/// `app.install`, …) to supply its label. Without this rule an installed app could
/// ship `myapp.use implies space.delete`, and every admin grant of `myapp.use` on
/// a space or the node ACL would also convey the kernel permission. A level whose
/// own id IS a kernel key is left alone: its edges are dropped by
/// [`crate::acl::vocabulary::build_vocabulary`], which also drops this edge as
/// defence in depth.
fn validate_levels_stay_out_of_kernel(levels: &[PermissionLevel]) -> Result<(), String> {
    let kernel = crate::identity_verify::permissions::PERMISSIONS;
    for level in levels {
        if kernel.contains(&level.id.as_str()) {
            continue;
        }
        if let Some(implied) = level
            .implies
            .iter()
            .find(|implied| kernel.contains(&implied.as_str()))
        {
            return Err(format!(
                "permission level '{}' implies kernel permission '{implied}'; an app level may only imply levels the app owns",
                level.id
            ));
        }
    }
    Ok(())
}

/// Warn once per process for each tool runnable still declaring the deprecated
/// `inline_deno` backend name. The manifest set is re-read on many request paths
/// (`PluginManifestLoader::load`), so a per-load warning would repeat on every
/// one of them; the author needs to see it, not have it flood the log.
fn warn_legacy_inline_deno_once(plugin: &str, runnable: &str, source: &str) {
    static WARNED: std::sync::OnceLock<std::sync::Mutex<HashSet<String>>> =
        std::sync::OnceLock::new();
    let first = WARNED
        .get_or_init(Default::default)
        .lock()
        .map(|mut warned| warned.insert(format!("{plugin}\u{0}{runnable}")))
        // A poisoned lock must not swallow the deprecation; warn again instead.
        .unwrap_or(true);
    if first {
        tracing::warn!(
            plugin,
            runnable,
            source,
            "plugin_manifest: tool backend 'inline_deno' is deprecated; rename it to 'inline_js'"
        );
    }
}

#[cfg(test)]
mod tests;
