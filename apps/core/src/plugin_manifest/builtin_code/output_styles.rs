//! Embedded `contributes.output_styles[].file` bodies (inert prose).
//!
//! Split out of `builtin_code.rs` to keep each file within the repository size
//! limits; the module docs there explain the tables and their bijection tests.

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
/// - A `code_file` is **sandboxed** JS, spliced into a deny-by-default JS sandbox IIFE.
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
/// Rows are sorted by path within the plugin, matching [`super::BUILTIN_CODE_FILES`].
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
        include_str!("../../../../../generated/ryu-runtime/apps-store/blueprint/output-styles/visual-planning.md"),
    ),
    // ── plugins-store ────────────────────────────────────────────────────────
    // output-styles
    (
        "@ryu/output-styles",
        "output-styles/bro.md",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/bro.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/concise.md",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/concise.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/eli5.md",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/eli5.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/gen-z.md",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/gen-z.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/explanatory.md",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/explanatory.md"
        ),
    ),
    (
        "@ryu/output-styles",
        "output-styles/i-have-adhd.md",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/i-have-adhd.md"
        ),
    ),
    (
        "@ryu/output-styles",
        "output-styles/learning.md",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/learning.md"
        ),
    ),
    (
        "@ryu/output-styles",
        "output-styles/no-ai-slop.md",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/no-ai-slop.md"
        ),
    ),
    (
        "@ryu/output-styles",
        "output-styles/no-hype.md",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/no-hype.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/plain-text.md",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/plain-text.md"
        ),
    ),
    (
        "@ryu/output-styles",
        "output-styles/plain-technical.md",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/plain-technical.md"
        ),
    ),
    (
        "@ryu/output-styles",
        "output-styles/proactive.md",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/proactive.md"
        ),
    ),
];

#[cfg(not(test))]
pub(crate) const BUILTIN_OUTPUT_STYLES: &[(&str, &str, &str)] = &[
    (
        "@ryu/blueprint",
        "output-styles/visual-planning.md",
        include_str!("../../../../../generated/ryu-runtime/apps-store/blueprint/output-styles/visual-planning.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/bro.md",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/bro.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/concise.md",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/concise.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/eli5.md",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/eli5.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/gen-z.md",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/gen-z.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/explanatory.md",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/explanatory.md"
        ),
    ),
    (
        "@ryu/output-styles",
        "output-styles/i-have-adhd.md",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/i-have-adhd.md"
        ),
    ),
    (
        "@ryu/output-styles",
        "output-styles/learning.md",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/learning.md"
        ),
    ),
    (
        "@ryu/output-styles",
        "output-styles/no-ai-slop.md",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/no-ai-slop.md"
        ),
    ),
    (
        "@ryu/output-styles",
        "output-styles/no-hype.md",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/no-hype.md"),
    ),
    (
        "@ryu/output-styles",
        "output-styles/plain-text.md",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/plain-text.md"
        ),
    ),
    (
        "@ryu/output-styles",
        "output-styles/plain-technical.md",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/plain-technical.md"
        ),
    ),
    (
        "@ryu/output-styles",
        "output-styles/proactive.md",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/output-styles/proactive.md"
        ),
    ),
];

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
