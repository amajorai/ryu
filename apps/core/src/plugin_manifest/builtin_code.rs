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
//!
//! The test-build code table lives in `builtin_code/code_files_test.rs`, and the Pi
//! extension and output-style tables in `builtin_code/pi_extensions.rs` and
//! `builtin_code/output_styles.rs`. The production code table stays here: a test
//! reads this file's source after its production `cfg` marker.

#[cfg(test)]
mod code_files_test;
mod output_styles;
mod pi_extensions;

#[cfg(test)]
pub(crate) use code_files_test::BUILTIN_CODE_FILES;
pub(crate) use output_styles::lookup_output_style;
#[cfg(test)]
pub(crate) use output_styles::BUILTIN_OUTPUT_STYLES;
#[cfg(test)]
pub(crate) use pi_extensions::BUILTIN_PI_EXTENSIONS;
pub(crate) use pi_extensions::{builtin_pi_extension_sources, lookup_pi_extension};

/// Production subset of the test-build table (`code_files_test.rs`): only bodies whose manifests are compiled
/// into the production runtime set (`CORE_RUNTIME_BUILTIN_MANIFESTS` /
/// `CORE_INSTALLABLE_BUILTIN_MANIFESTS` in [`super`]), the
/// only manifests hydrated with `code_base: None`. A Core-tier package installed
/// from the Marketplace (e.g. `@ryu/ego-browser`, which earns Core tier as a
/// digest-verified official package) hydrates its `code_file`s from its on-disk
/// package directory, so a row here for it would be dead embedded code.
#[cfg(not(test))]
pub(crate) const BUILTIN_CODE_FILES: &[(&str, &str, &str)] = &[
    // apps-store satellites promoted into the production standalone registry
    (
        "@ryu/news",
        "hooks/ground.js",
        include_str!("../../../../generated/ryu-runtime/apps-store/news/hooks/ground.js"),
    ),
    (
        "@ryu/reasoning",
        "adapters/verify.claim.js",
        include_str!("../../../../generated/ryu-runtime/apps-store/reasoning/adapters/verify.claim.js"),
    ),
    (
        "@ryu/reasoning",
        "adapters/verify.scopes.js",
        include_str!("../../../../generated/ryu-runtime/apps-store/reasoning/adapters/verify.scopes.js"),
    ),
    (
        "@ryu/reasoning",
        "hooks/check.js",
        include_str!("../../../../generated/ryu-runtime/apps-store/reasoning/hooks/check.js"),
    ),
    (
        "@ryu/rlm",
        "hooks/deep-read.js",
        include_str!("../../../../generated/ryu-runtime/apps-store/rlm/hooks/deep-read.js"),
    ),
    (
        "@ryu/tuition",
        "hooks/study.js",
        include_str!("../../../../generated/ryu-runtime/apps-store/tuition/hooks/study.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.click.js",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/agentbrowser/adapters/browser.click.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.screenshot.js",
        include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/agentbrowser/adapters/browser.screenshot.js"
        ),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.scroll.js",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/agentbrowser/adapters/browser.scroll.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.snapshot.js",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/agentbrowser/adapters/browser.snapshot.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.type.js",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/agentbrowser/adapters/browser.type.js"),
    ),
    (
        "@ryu/chat-title",
        "hooks/rename.js",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/chat-title/hooks/rename.js"),
    ),
    (
        "@ryu/double-check",
        "hooks/review.js",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/double-check/hooks/review.js"),
    ),
    (
        "@ryu/exa",
        "adapters/web.search.js",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/exa/adapters/web.search.js"),
    ),
    // scrapling
    (
        "@ryu/scrapling",
        "adapters/web.extract.js",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/scrapling/adapters/web.extract.js"),
    ),
    (
        "@ryu/goal",
        "hooks/loop.js",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/goal/hooks/loop.js"),
    ),
    (
        "@ryu/proof",
        "hooks/loop.js",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/proof/hooks/loop.js"),
    ),
    (
        "@ryu/receipts",
        "hooks/loop.js",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/receipts/hooks/loop.js"),
    ),
    (
        "@ryu/rules",
        "hooks/inject.js",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/rules/hooks/inject.js"),
    ),
    (
        "@ryu/codex-computer-use",
        "adapters/computer.capture.js",
        include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/codex-computer-use/adapters/computer.capture.js"
        ),
    ),
    (
        "@ryu/codex-computer-use",
        "adapters/computer.click.js",
        include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/codex-computer-use/adapters/computer.click.js"
        ),
    ),
    (
        "@ryu/codex-computer-use",
        "adapters/computer.key.js",
        include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/codex-computer-use/adapters/computer.key.js"
        ),
    ),
    (
        "@ryu/codex-computer-use",
        "adapters/computer.type.js",
        include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/codex-computer-use/adapters/computer.type.js"
        ),
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
