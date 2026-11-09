//! Embedded `contributes.pi_extensions[].file` sources (unsandboxed TypeScript).
//!
//! Split out of `builtin_code.rs` to keep each file within the repository size
//! limits; the module docs there explain the tables and their bijection tests.

/// `(plugin id, plugin-root-relative path, file contents)` for every
/// `contributes.pi_extensions[].file` a `plugins-store` manifest references.
///
/// # Why a SECOND table and not more rows in [`super::BUILTIN_CODE_FILES`]
///
/// Same embedding problem, different privilege — and the separation is the point:
///
/// - A `code_file` is **sandboxed** JS. Core splices it into a deny-by-default JS
///   sandbox IIFE where every side effect goes through a capability-gated `host.*` call.
/// - A `pi_extensions[].file` is **unsandboxed** TypeScript loaded by the managed Pi
///   process itself, with that process's full privilege. It is gated like a manifest
///   `mcp_servers` entry (`pi_config::app_extensions::may_ship_pi_extensions`), not
///   like a hook.
///
/// One table would also break the other one's guard: `builtin_code_table_matches_package_manifests`
/// asserts a bijection over [`super::super::PluginManifest::code_file_refs`], which by
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
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/pi-shell/pi-extensions/ryu-shell.ts"),
    ),
    // pi-subagent
    (
        "@ryu/pi-subagent",
        "pi-extensions/ryu-subagent.ts",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/pi-subagent/pi-extensions/ryu-subagent.ts"),
    ),
    // pi-monitor
    (
        "@ryu/pi-monitor",
        "pi-extensions/ryu-monitor.ts",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/pi-monitor/pi-extensions/ryu-monitor.ts"),
    ),
    // pi-copy
    (
        "@ryu/pi-copy",
        "pi-extensions/ryu-copy.ts",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/pi-copy/pi-extensions/ryu-copy.ts"),
    ),
    (
        "@ryu/tokeneconomizer",
        "pi-extensions/ryu-tokeneconomizer.ts",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/tokeneconomizer/pi-extensions/ryu-tokeneconomizer.ts"
        ),
    ),
];

#[cfg(not(test))]
pub(crate) const BUILTIN_PI_EXTENSIONS: &[(&str, &str, &str)] = &[
    (
        "@ryu/pi-shell",
        "pi-extensions/ryu-shell.ts",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/pi-shell/pi-extensions/ryu-shell.ts"),
    ),
    (
        "@ryu/pi-subagent",
        "pi-extensions/ryu-subagent.ts",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/pi-subagent/pi-extensions/ryu-subagent.ts"),
    ),
    (
        "@ryu/pi-monitor",
        "pi-extensions/ryu-monitor.ts",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/pi-monitor/pi-extensions/ryu-monitor.ts"),
    ),
    (
        "@ryu/pi-copy",
        "pi-extensions/ryu-copy.ts",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/pi-copy/pi-extensions/ryu-copy.ts"),
    ),
    (
        "@ryu/tokeneconomizer",
        "pi-extensions/ryu-tokeneconomizer.ts",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/tokeneconomizer/pi-extensions/ryu-tokeneconomizer.ts"
        ),
    ),
];

/// Every embedded built-in plugin Pi extension as `(relative path, source)`.
pub(crate) fn builtin_pi_extension_sources() -> impl Iterator<Item = (&'static str, &'static str)> {
    BUILTIN_PI_EXTENSIONS
        .iter()
        .map(|(_, path, source)| (*path, *source))
}

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
