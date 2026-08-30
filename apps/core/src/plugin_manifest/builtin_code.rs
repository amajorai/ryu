//! Files a built-in plugin's manifest references by path, embedded at compile time.
//!
//! Three tables, one per kind of file a manifest can name, ordered here by how much
//! privilege the contents carry: [`BUILTIN_CODE_FILES`] holds the **sandboxed** JS a
//! `code_file` names, [`BUILTIN_PI_EXTENSIONS`] holds the **unsandboxed** TypeScript
//! a `contributes.pi_extensions[].file` names, and [`BUILTIN_OUTPUT_STYLES`] holds
//! the **inert prose** a `contributes.output_styles[].file` names. They must not be
//! merged; see each later table's own doc for why.
//!
//! # Why a table and not a directory read
//!
//! A built-in plugin ships ONLY its manifest: Core `include_str!`s
//! `plugins-store/{plugins,lsp,external_plugins}/<dir>/manifest.json` (see [`super::BUILTIN_MANIFESTS`]) and the
//! package directory is not on the user's machine — the same reason
//! `skills_catalog::plugin_skills` returns `None` for a built-in. So a manifest that
//! moved its hook/adapter bodies into real `.js` files needs those files compiled in
//! too, or the hook would resolve to nothing at runtime.
//!
//! # Why hand-written `include_str!` and not a `build.rs` generator
//!
//! `tools/mirror-public.sh` step 3b greps **literal** `include_str!` paths out of the
//! mirrored `apps/core/src/**.rs` and refuses to publish a tree in which one does not
//! resolve. A hand-written table is therefore self-verifying in the mirror. A
//! generated one would live in `OUT_DIR`, bypass that gate silently, and the missing
//! file would first surface in public release CI — i.e. after publication.
//!
//! # Keeping it honest
//!
//! Every `code_file` in every `{plugins,apps}-store/*/manifest.json` has a row here
//! and every row is referenced by some manifest — a bijection asserted by
//! `builtin_code_table_matches_package_manifests` in [`super`]. Unregistered-by-design
//! plugins are included too: they are loaded from disk today, but the total invariant
//! is what makes promoting one to a built-in a one-line change instead of a silent
//! no-op.
//!
//! Each table has its OWN bijection test, for the reason each table is its own
//! table: the three reference lists ([`super::PluginManifest::code_file_refs`],
//! `pi_extension_refs`, `output_style_refs`) are disjoint by construction, so one
//! merged assertion would be satisfiable by a row of the wrong kind.

/// `(plugin id, package-root-relative path, file contents)` for every `code_file` a
/// package manifest references — from EITHER store root, since an apps-store app can
/// contribute a turn hook exactly like a plugin can (`packaged_code_file_refs` walks
/// both, and `tools/mirror-public.sh` step 1c vendors `apps-store/*/hooks/*.js`
/// alongside the plugins-store ones). Sorted by root, then package dir, then path.
#[cfg(test)]
pub(crate) const BUILTIN_CODE_FILES: &[(&str, &str, &str)] = &[
    // ── apps-store ───────────────────────────────────────────────────────────
    // reasoning
    (
        "@ryu/reasoning",
        "hooks/check.js",
        include_str!("../../../../apps-store/reasoning/hooks/check.js"),
    ),
    // tuition
    (
        "@ryu/tuition",
        "hooks/study.js",
        include_str!("../../../../apps-store/tuition/hooks/study.js"),
    ),
    // news
    (
        "@ryu/news",
        "hooks/ground.js",
        include_str!("../../../../apps-store/news/hooks/ground.js"),
    ),
    // rlm
    (
        "@ryu/rlm",
        "hooks/deep-read.js",
        include_str!("../../../../apps-store/rlm/hooks/deep-read.js"),
    ),
    // ── plugins-store ────────────────────────────────────────────────────────
    // effort-escalator
    (
        "@ryu/effort-escalator",
        "hooks/judge.js",
        include_str!("../../../../plugins-store/plugins/effort-escalator/hooks/judge.js"),
    ),
    (
        "@ryu/effort-escalator",
        "hooks/select-model.js",
        include_str!("../../../../plugins-store/plugins/effort-escalator/hooks/select-model.js"),
    ),
    // usage-pacer
    (
        "@ryu/usage-pacer",
        "hooks/select-model.js",
        include_str!("../../../../plugins-store/plugins/usage-pacer/hooks/select-model.js"),
    ),
    // advisor
    (
        "@ryu/advisor",
        "hooks/review.js",
        include_str!("../../../../plugins-store/plugins/advisor/hooks/review.js"),
    ),
    // agent-comms
    (
        "@ryu/agent-comms",
        "hooks/deliver.js",
        include_str!("../../../../plugins-store/plugins/agent-comms/hooks/deliver.js"),
    ),
    (
        "@ryu/agent-comms",
        "hooks/directory.js",
        include_str!("../../../../plugins-store/plugins/agent-comms/hooks/directory.js"),
    ),
    // agents-md-tail
    (
        "@ryu/agents-md-tail",
        "hooks/inject.js",
        include_str!("../../../../plugins-store/plugins/agents-md-tail/hooks/inject.js"),
    ),
    // rules
    (
        "@ryu/rules",
        "hooks/inject.js",
        include_str!("../../../../plugins-store/plugins/rules/hooks/inject.js"),
    ),
    // agentbrowser
    (
        "@ryu/agentbrowser",
        "adapters/browser.click.js",
        include_str!("../../../../plugins-store/plugins/agentbrowser/adapters/browser.click.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.screenshot.js",
        include_str!("../../../../plugins-store/plugins/agentbrowser/adapters/browser.screenshot.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.scroll.js",
        include_str!("../../../../plugins-store/plugins/agentbrowser/adapters/browser.scroll.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.snapshot.js",
        include_str!("../../../../plugins-store/plugins/agentbrowser/adapters/browser.snapshot.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.type.js",
        include_str!("../../../../plugins-store/plugins/agentbrowser/adapters/browser.type.js"),
    ),
    // ego-browser
    (
        "@ryu/ego-browser",
        "adapters/browser.click.js",
        include_str!("../../../../plugins-store/plugins/ego-browser/adapters/browser.click.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.navigate.js",
        include_str!("../../../../plugins-store/plugins/ego-browser/adapters/browser.navigate.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.screenshot.js",
        include_str!("../../../../plugins-store/plugins/ego-browser/adapters/browser.screenshot.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.scroll.js",
        include_str!("../../../../plugins-store/plugins/ego-browser/adapters/browser.scroll.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.snapshot.js",
        include_str!("../../../../plugins-store/plugins/ego-browser/adapters/browser.snapshot.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.tabs.js",
        include_str!("../../../../plugins-store/plugins/ego-browser/adapters/browser.tabs.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.type.js",
        include_str!("../../../../plugins-store/plugins/ego-browser/adapters/browser.type.js"),
    ),
    // cloudflare-browser-run (external provider)
    (
        "@ryu/cloudflare-browser-run",
        "adapters/browser.navigate.js",
        include_str!(
            "../../../../plugins-store/external_plugins/cloudflare-browser-run/adapters/browser.navigate.js"
        ),
    ),
    (
        "@ryu/cloudflare-browser-run",
        "adapters/browser.screenshot.js",
        include_str!(
            "../../../../plugins-store/external_plugins/cloudflare-browser-run/adapters/browser.screenshot.js"
        ),
    ),
    (
        "@ryu/cloudflare-browser-run",
        "adapters/browser.snapshot.js",
        include_str!(
            "../../../../plugins-store/external_plugins/cloudflare-browser-run/adapters/browser.snapshot.js"
        ),
    ),
    // chat-title
    (
        "@ryu/chat-title",
        "hooks/rename.js",
        include_str!("../../../../plugins-store/plugins/chat-title/hooks/rename.js"),
    ),
    // double-check
    (
        "@ryu/double-check",
        "hooks/review.js",
        include_str!("../../../../plugins-store/plugins/double-check/hooks/review.js"),
    ),
    // exa
    (
        "@ryu/exa",
        "adapters/web.search.js",
        include_str!("../../../../plugins-store/plugins/exa/adapters/web.search.js"),
    ),
    // firecrawl
    (
        "@ryu/firecrawl",
        "adapters/web.crawl.js",
        include_str!("../../../../plugins-store/plugins/firecrawl/adapters/web.crawl.js"),
    ),
    (
        "@ryu/firecrawl",
        "adapters/web.extract.js",
        include_str!("../../../../plugins-store/plugins/firecrawl/adapters/web.extract.js"),
    ),
    // goal
    (
        "@ryu/goal",
        "hooks/loop.js",
        include_str!("../../../../plugins-store/plugins/goal/hooks/loop.js"),
    ),
    // honcho
    (
        "@ryu/honcho",
        "adapters/memory.store.js",
        include_str!("../../../../plugins-store/plugins/honcho/adapters/memory.store.js"),
    ),
    (
        "@ryu/honcho",
        "adapters/memory.sync.js",
        include_str!("../../../../plugins-store/plugins/honcho/adapters/memory.sync.js"),
    ),
    // hook-observers
    (
        "@ryu/hook-observers",
        "hooks/notification.js",
        include_str!("../../../../plugins-store/plugins/hook-observers/hooks/notification.js"),
    ),
    (
        "@ryu/hook-observers",
        "hooks/session-end.js",
        include_str!("../../../../plugins-store/plugins/hook-observers/hooks/session-end.js"),
    ),
    (
        "@ryu/hook-observers",
        "hooks/subagent-stop.js",
        include_str!("../../../../plugins-store/plugins/hook-observers/hooks/subagent-stop.js"),
    ),
    (
        "@ryu/hook-observers",
        "hooks/workflow-run-failed.js",
        include_str!("../../../../plugins-store/plugins/hook-observers/hooks/workflow-run-failed.js"),
    ),
    (
        "@ryu/hook-observers",
        "hooks/app-event-meeting-ended.js",
        include_str!("../../../../plugins-store/plugins/hook-observers/hooks/app-event-meeting-ended.js"),
    ),
    // hook-session-context
    (
        "@ryu/session-context",
        "hooks/start.js",
        include_str!("../../../../plugins-store/plugins/hook-session-context/hooks/start.js"),
    ),
    // no-ai-slop
    (
        "@ryu/no-ai-slop",
        "hooks/review.js",
        include_str!("../../../../plugins-store/plugins/no-ai-slop/hooks/review.js"),
    ),
    // no-more-mistakes
    (
        "@ryu/no-more-mistakes",
        "hooks/capture.js",
        include_str!("../../../../plugins-store/plugins/no-more-mistakes/hooks/capture.js"),
    ),
    (
        "@ryu/no-more-mistakes",
        "hooks/brief.js",
        include_str!("../../../../plugins-store/plugins/no-more-mistakes/hooks/brief.js"),
    ),
    (
        "@ryu/no-more-mistakes",
        "hooks/command.js",
        include_str!("../../../../plugins-store/plugins/no-more-mistakes/hooks/command.js"),
    ),
    // parallel
    (
        "@ryu/parallel",
        "adapters/web.search.js",
        include_str!("../../../../plugins-store/plugins/parallel/adapters/web.search.js"),
    ),
    // plan-continue
    (
        "@ryu/plan-continue",
        "hooks/loop.js",
        include_str!("../../../../plugins-store/plugins/plan-continue/hooks/loop.js"),
    ),
    // auto-continue
    (
        "@ryu/auto-continue",
        "hooks/loop.js",
        include_str!("../../../../plugins-store/plugins/auto-continue/hooks/loop.js"),
    ),
    // proof
    (
        "@ryu/proof",
        "hooks/loop.js",
        include_str!("../../../../plugins-store/plugins/proof/hooks/loop.js"),
    ),
    // recap
    (
        "@ryu/recap",
        "hooks/command.js",
        include_str!("../../../../plugins-store/plugins/recap/hooks/command.js"),
    ),
    (
        "@ryu/recap",
        "hooks/turn.js",
        include_str!("../../../../plugins-store/plugins/recap/hooks/turn.js"),
    ),
    // receipts
    (
        "@ryu/receipts",
        "hooks/loop.js",
        include_str!("../../../../plugins-store/plugins/receipts/hooks/loop.js"),
    ),
    // scrapling
    (
        "@ryu/scrapling",
        "adapters/web.extract.js",
        include_str!("../../../../plugins-store/plugins/scrapling/adapters/web.extract.js"),
    ),
    // security-guidance
    (
        "@ryu/security-guidance",
        "hooks/review.js",
        include_str!("../../../../plugins-store/plugins/security-guidance/hooks/review.js"),
    ),
    // security-scanner
    (
        "@ryu/security-scanner",
        "hooks/auto-review.js",
        include_str!("../../../../plugins-store/plugins/security-scanner/hooks/auto-review.js"),
    ),
    (
        "@ryu/security-scanner",
        "hooks/command.js",
        include_str!("../../../../plugins-store/plugins/security-scanner/hooks/command.js"),
    ),
    // tool-firewall
    (
        "@ryu/tool-firewall",
        "hooks/post.js",
        include_str!("../../../../plugins-store/plugins/tool-firewall/hooks/post.js"),
    ),
    (
        "@ryu/tool-firewall",
        "hooks/pre.js",
        include_str!("../../../../plugins-store/plugins/tool-firewall/hooks/pre.js"),
    ),
];

#[cfg(not(test))]
pub(crate) const BUILTIN_CODE_FILES: &[(&str, &str, &str)] = &[
    // apps-store satellites promoted into the production standalone registry
    (
        "@ryu/news",
        "hooks/ground.js",
        include_str!("../../../../apps-store/news/hooks/ground.js"),
    ),
    (
        "@ryu/reasoning",
        "hooks/check.js",
        include_str!("../../../../apps-store/reasoning/hooks/check.js"),
    ),
    (
        "@ryu/rlm",
        "hooks/deep-read.js",
        include_str!("../../../../apps-store/rlm/hooks/deep-read.js"),
    ),
    (
        "@ryu/tuition",
        "hooks/study.js",
        include_str!("../../../../apps-store/tuition/hooks/study.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.click.js",
        include_str!("../../../../plugins-store/plugins/agentbrowser/adapters/browser.click.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.screenshot.js",
        include_str!(
            "../../../../plugins-store/plugins/agentbrowser/adapters/browser.screenshot.js"
        ),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.scroll.js",
        include_str!("../../../../plugins-store/plugins/agentbrowser/adapters/browser.scroll.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.snapshot.js",
        include_str!("../../../../plugins-store/plugins/agentbrowser/adapters/browser.snapshot.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.type.js",
        include_str!("../../../../plugins-store/plugins/agentbrowser/adapters/browser.type.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.click.js",
        include_str!("../../../../plugins-store/plugins/ego-browser/adapters/browser.click.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.navigate.js",
        include_str!("../../../../plugins-store/plugins/ego-browser/adapters/browser.navigate.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.screenshot.js",
        include_str!(
            "../../../../plugins-store/plugins/ego-browser/adapters/browser.screenshot.js"
        ),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.scroll.js",
        include_str!("../../../../plugins-store/plugins/ego-browser/adapters/browser.scroll.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.snapshot.js",
        include_str!("../../../../plugins-store/plugins/ego-browser/adapters/browser.snapshot.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.tabs.js",
        include_str!("../../../../plugins-store/plugins/ego-browser/adapters/browser.tabs.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.type.js",
        include_str!("../../../../plugins-store/plugins/ego-browser/adapters/browser.type.js"),
    ),
];

/// The embedded contents of `rel` for built-in plugin `plugin_id`, or `None` when
/// the manifest names a file that was never added to [`BUILTIN_CODE_FILES`].
///
/// `None` is a hard load error at the call site, never an empty hook body.
pub(crate) fn lookup(plugin_id: &str, rel: &str) -> Option<&'static str> {
    BUILTIN_CODE_FILES
        .iter()
        .find(|(id, path, _)| *id == plugin_id && *path == rel)
        .map(|(_, _, code)| *code)
}

/// `(plugin id, plugin-root-relative path, file contents)` for every
/// `contributes.pi_extensions[].file` a `plugins-store` manifest references.
///
/// # Why a SECOND table and not more rows in [`BUILTIN_CODE_FILES`]
///
/// Same embedding problem, different privilege — and the separation is the point:
///
/// - A `code_file` is **sandboxed** JS. Core splices it into a deny-by-default Deno
///   IIFE where every side effect goes through a capability-gated `host.*` call.
/// - A `pi_extensions[].file` is **unsandboxed** TypeScript loaded by the managed Pi
///   process itself, with that process's full privilege. It is gated like a manifest
///   `mcp_servers` entry (`pi_config::app_extensions::may_ship_pi_extensions`), not
///   like a hook.
///
/// One table would also break the other one's guard: `builtin_code_table_matches_package_manifests`
/// asserts a bijection over [`super::PluginManifest::code_file_refs`], which by
/// construction never yields a `.ts`. Each table therefore has its own bijection
/// test. Everything else about the mechanism — hand-written `include_str!` so
/// `tools/mirror-public.sh` step 3b can grep the literal paths, and a `None` lookup
/// being a visible skip rather than an empty file — is identical.
#[cfg(test)]
pub(crate) const BUILTIN_PI_EXTENSIONS: &[(&str, &str, &str)] = &[
    // pi-shell
    (
        "@ryu/pi-shell",
        "pi-extensions/ryu-shell.ts",
        include_str!("../../../../plugins-store/plugins/pi-shell/pi-extensions/ryu-shell.ts"),
    ),
    // pi-subagent
    (
        "@ryu/pi-subagent",
        "pi-extensions/ryu-subagent.ts",
        include_str!("../../../../plugins-store/plugins/pi-subagent/pi-extensions/ryu-subagent.ts"),
    ),
    // pi-monitor
    (
        "@ryu/pi-monitor",
        "pi-extensions/ryu-monitor.ts",
        include_str!("../../../../plugins-store/plugins/pi-monitor/pi-extensions/ryu-monitor.ts"),
    ),
];

#[cfg(not(test))]
pub(crate) const BUILTIN_PI_EXTENSIONS: &[(&str, &str, &str)] = &[];

/// The embedded contents of `rel` for built-in plugin `plugin_id`, or `None` when
/// nothing in [`BUILTIN_PI_EXTENSIONS`] matches.
///
/// `None` sends the resolver to the plugin's on-disk directory, which is the right
/// answer for a Community plugin and a visible skip for a built-in (whose package
/// dir is not on the user's machine).
pub(crate) fn lookup_pi_extension(plugin_id: &str, rel: &str) -> Option<&'static str> {
    BUILTIN_PI_EXTENSIONS
        .iter()
        .find(|(id, path, _)| *id == plugin_id && *path == rel)
        .map(|(_, _, source)| *source)
}

/// `(plugin id, plugin-root-relative path, file contents)` for every
/// `contributes.output_styles[].file` a packaged manifest references — **both**
/// roots, `apps-store` as well as `plugins-store`. An App contributes a style by
/// exactly the same three-field row as a plugin (`packaged_output_style_refs`
/// walks both roots), and the first one to do so is `@ryu/blueprint`, whose style
/// is the only thing that makes an agent publish a plan for review at all.
///
/// # Why a THIRD table
///
/// Same embedding problem again — a built-in ships only its `manifest.json`, so a
/// style whose body is not compiled in resolves to nothing — but the contents sit at
/// the OPPOSITE end of the privilege scale from the other two tables, and that is
/// exactly why they stay apart:
///
/// - A `code_file` is **sandboxed** JS, spliced into a deny-by-default Deno IIFE.
/// - A `pi_extensions[].file` is **unsandboxed** TypeScript with the managed Pi
///   process's full privilege.
/// - An `output_styles[].file` is **inert prose**. Nothing in the pipeline evaluates
///   it; it is appended to (or replaces) the agent's base instructions for a turn and
///   is otherwise plain text, which is why a style contribution needs no capability
///   grant at all — the argument `ThemeContribution` already makes for themes, and
///   the reason `@ryu/output-styles` ships with an empty `permission_grants`.
///
/// Merging any two of these is one edit away from letting a file wear another's
/// clothes: a single parameterised table would have one path allowlist, and
/// `validate_output_style_path` exists precisely so a style cannot name a
/// `hooks/*.js` and a `code_file` cannot name a `.md`. The bijection tests would
/// fall over too — see the module doc.
///
/// Rows are sorted by path within the plugin, matching [`BUILTIN_CODE_FILES`].
#[cfg(test)]
pub(crate) const BUILTIN_OUTPUT_STYLES: &[(&str, &str, &str)] = &[
    // ── apps-store ───────────────────────────────────────────────────────────
    // blueprint — the "Visual planning" style. This row is what makes the app
    // work rather than merely load: Blueprint ships no turn hooks, so nothing in
    // the runtime ever forces a plan to be published. The style is the whole
    // mechanism — it tells the agent to publish before it edits and to wait for a
    // verdict. Without this embedded body a built-in install resolves the
    // manifest's `output-styles/visual-planning.md` against a package directory
    // that is not on the user's machine, which `hydrate_output_style_files` treats
    // as a HARD load error (deliberately — an empty style is indistinguishable
    // from the user choosing none).
    (
        "@ryu/blueprint",
        "output-styles/visual-planning.md",
        include_str!("../../../../apps-store/blueprint/output-styles/visual-planning.md"),
    ),
    // ── plugins-store ────────────────────────────────────────────────────────
    // output-styles
    (
        "@ryu/output-styles",
        "output-styles/bro.md",
        include_str!("../../../../plugins-store/plugins/output-styles/output-styles/bro.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/eli5.md",
        include_str!("../../../../plugins-store/plugins/output-styles/output-styles/eli5.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/gen-z.md",
        include_str!("../../../../plugins-store/plugins/output-styles/output-styles/gen-z.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/explanatory.md",
        include_str!(
            "../../../../plugins-store/plugins/output-styles/output-styles/explanatory.md"
        ),
    ),
    (
        "@ryu/output-styles",
        "output-styles/i-have-adhd.md",
        include_str!(
            "../../../../plugins-store/plugins/output-styles/output-styles/i-have-adhd.md"
        ),
    ),
    (
        "@ryu/output-styles",
        "output-styles/learning.md",
        include_str!("../../../../plugins-store/plugins/output-styles/output-styles/learning.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/no-ai-slop.md",
        include_str!("../../../../plugins-store/plugins/output-styles/output-styles/no-ai-slop.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/no-hype.md",
        include_str!("../../../../plugins-store/plugins/output-styles/output-styles/no-hype.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/plain-text.md",
        include_str!("../../../../plugins-store/plugins/output-styles/output-styles/plain-text.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/plain-technical.md",
        include_str!(
            "../../../../plugins-store/plugins/output-styles/output-styles/plain-technical.md"
        ),
    ),
    (
        "@ryu/output-styles",
        "output-styles/proactive.md",
        include_str!("../../../../plugins-store/plugins/output-styles/output-styles/proactive.md"),
    ),
];

#[cfg(not(test))]
pub(crate) const BUILTIN_OUTPUT_STYLES: &[(&str, &str, &str)] = &[(
    "@ryu/blueprint",
    "output-styles/visual-planning.md",
    include_str!("../../../../apps-store/blueprint/output-styles/visual-planning.md"),
)];

/// The embedded contents of `rel` for built-in plugin `plugin_id`, or `None` when
/// nothing in [`BUILTIN_OUTPUT_STYLES`] matches.
///
/// `None` is a hard load error at the call site, never an empty style. An empty
/// body is the one degradation no read site can distinguish from the user's own
/// choice not to use a style, so the plugin must fail to load instead.
pub(crate) fn lookup_output_style(plugin_id: &str, rel: &str) -> Option<&'static str> {
    BUILTIN_OUTPUT_STYLES
        .iter()
        .find(|(id, path, _)| *id == plugin_id && *path == rel)
        .map(|(_, _, source)| *source)
}
