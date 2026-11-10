//! Resolving and probing stdio MCP server commands.

use super::*;

/// Rung 2 of [`mcp_server_config_from_decl`]: the absolute path of `command` inside the
/// Ryu-managed bin dir, when `command` is a bare name and that file exists.
///
/// Bare-only on purpose. A declaration that already carries a path separator is a path —
/// absolute or relative to Core's cwd — and joining it under `<data dir>/bin` would both
/// change its meaning and let `..` segments walk out of the bin dir. `Command::new` does
/// not consult `PATH` for such a command either, so there is nothing to improve.
///
/// Trimmed before the check because nothing upstream trims `decl.command` (only its
/// `command_env` override is trimmed) — the same normalization [`mcp_command_is_present`]
/// and [`spawn_program_for`] apply, so `" ryu-thing "` cannot resolve here and then miss
/// there. Returns `None` on no hit, leaving the caller's fallthrough byte-identical to
/// the pre-existing behavior (the untrimmed `decl.command`).
pub(super) fn managed_bin_fallback(command: &str) -> Option<String> {
    let command = command.trim();
    if command.is_empty() || command.contains('/') || (cfg!(windows) && command.contains('\\')) {
        return None;
    }
    let candidate = crate::sidecar::manifest_sidecar::managed_bin_path(command);
    candidate
        .is_file()
        .then(|| candidate.to_string_lossy().into_owned())
}

/// The directory a plugin's package files were materialized into: the first
/// `<plugins dir>/<entry>` whose manifest names `plugin_id`, in the order the
/// manifest loader reads them, so it is the package the loaded manifest came from
/// (a hand-installed copy under another name, or a stale package with the same id
/// next to it, included). `None` when there is none.
///
/// A stdio server declared as `node server.mjs` names a file the package ships,
/// but a child otherwise inherits Core's own cwd, so the script resolved against
/// wherever Core happened to start and the server failed on its first spawn. A built-in compiled into Core has no
/// directory, so it keeps the inherited cwd rather than a path that cannot exist.
pub(super) fn installed_plugin_dir(plugin_id: &str) -> Option<std::path::PathBuf> {
    installed_plugin_dir_in(
        &crate::plugin_manifest::PluginManifestLoader::plugins_dir(),
        plugin_id,
    )
}

/// [`installed_plugin_dir`] over an explicit plugins root, so it is testable
/// without mutating the process-wide `RYU_PLUGINS_DIR`.
fn installed_plugin_dir_in(
    plugins_dir: &std::path::Path,
    plugin_id: &str,
) -> Option<std::path::PathBuf> {
    std::fs::read_dir(plugins_dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|dir| dir.is_dir())
        .find(|dir| package_manifest_id(dir).as_deref() == Some(plugin_id))
}

/// The `id` of the manifest in a plugin package directory, read the way the
/// manifest loader finds it (first of `manifest.json`, `plugin.json`, `ryu.json`).
fn package_manifest_id(dir: &std::path::Path) -> Option<String> {
    let manifest_path = crate::plugin_manifest::MANIFEST_FILE_NAMES
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.exists())?;
    let raw = std::fs::read_to_string(manifest_path).ok()?;
    let manifest: serde_json::Value = serde_json::from_str(&raw).ok()?;
    manifest.get("id")?.as_str().map(str::to_owned)
}

/// A relative stdio `command` that names a file in the package (`./bin/server`)
/// as the absolute path under the package directory `cwd`. A relative program is
/// resolved against `cwd` on Unix but against Core's cwd on Windows, and the
/// presence probe uses Core's, so anchoring it makes probe and spawn agree.
/// `Ok(None)` for a command that needs no rewrite (bare name, already absolute);
/// `Err(())` when it climbs out of the package with `..`.
pub(super) fn anchor_relative_command(
    command: &str,
    cwd: &std::path::Path,
) -> std::result::Result<Option<String>, ()> {
    let command = command.trim();
    let names_a_path = command.contains('/') || (cfg!(windows) && command.contains('\\'));
    let relative = std::path::Path::new(command);
    if !names_a_path || relative.is_absolute() {
        return Ok(None);
    }
    if relative.components().any(|part| {
        matches!(
            part,
            std::path::Component::ParentDir | std::path::Component::Prefix(_)
        )
    }) {
        return Err(());
    }
    Ok(Some(cwd.join(relative).to_string_lossy().into_owned()))
}

/// Whether the command an `mcp_servers` declaration would hand to `Command::new`
/// actually exists on this host.
///
/// Pure over the filesystem + `PATH` so it can be asserted directly; see
/// [`register_manifest_mcp_servers`] for why registration depends on it, and for the
/// resolved-command / runner-not-payload rules the callers must preserve.
///
/// A command carrying a path separator is checked as a **file** (that is what
/// `Command::new` will do with it — `PATH` is not consulted for a path), everything
/// else through `PATH`. Blank is `false`: there is nothing to spawn, and letting it
/// through would register a server whose spawn fails with an empty program name.
///
/// Three of its answers are only true because [`spawn_program_for`] normalizes the same
/// way on the way to `Command::new` — that pairing is the load-bearing part, spelled
/// out on [`register_manifest_mcp_servers`]:
///
/// * a `PATH` hit that is a Windows `.cmd`/`.bat` shim, which `Command::new` cannot
///   spawn from the bare name (it gets rewritten to the resolved path);
/// * a Windows `PATH` hit that is an **extensionless** file, which the bare name cannot
///   spawn either (`std` appends `.exe` and probes nothing else) — rewritten to the
///   resolved path when no `<name>.exe` exists on `PATH`. Note this answer is only *made*
///   true, not true by construction: `which_on_path`'s bare-`dir.join(program)` probe
///   accepts a file `Command::new` would never look at, so the probe is the party that
///   is wrong here (see the note on [`spawn_program_for`]);
/// * a command with surrounding whitespace — trimmed here, so it must be trimmed there
///   (nothing upstream *rewrites* an untrimmed command: `mcp_server_config_from_decl`
///   trims the `command_env` override and trims before its managed-bin-dir lookup, but
///   falls through with `decl.command` verbatim, and a pasted `mcp.json` trims nothing).
///
/// Note what is deliberately NOT here: the Ryu-managed `<data dir>/bin` lookup. That is a
/// resolution rung, and resolution belongs to `mcp_server_config_from_decl` alone — by the
/// time a managed binary reaches this probe its command already carries a separator and
/// takes the file branch above. Adding a second, independent bin-dir probe here would let
/// the two disagree, which is the exact class of bug this pairing exists to prevent.
pub(crate) fn mcp_command_is_present(command: &str) -> bool {
    let command = command.trim();
    if command.is_empty() {
        return false;
    }
    if command.contains('/') || (cfg!(windows) && command.contains('\\')) {
        return std::path::Path::new(command).is_file();
    }
    crate::sidecar::manifest_sidecar::which_on_path(command).is_some()
}

/// The transport-aware presence gate: can this config entry be *reached* at all?
///
/// [`mcp_command_is_present`] answers that for a stdio entry by probing the
/// filesystem/`PATH`. There is no equivalent question for a remote entry — an
/// HTTP endpoint has nothing installed locally — so a remote declaration is
/// present whenever it names a non-empty `url`.
///
/// This distinction is load-bearing, not cosmetic: [`register_manifest_mcp_servers`]
/// *skips* a server whose command is absent, with only a `warn!`. Left probing
/// `command`, every remote declaration would take that branch (its command is
/// `None` ⇒ blank ⇒ absent), so a perfectly valid hosted server would silently
/// never register and the only trace would be a log line saying its command was
/// not installed — describing a command it never had.
pub(crate) fn mcp_server_is_present(cfg: &McpServerConfig) -> bool {
    match cfg.transport_kind() {
        McpTransportKind::Http | McpTransportKind::Sse => {
            cfg.url.as_deref().is_some_and(|u| !u.trim().is_empty())
        }
        McpTransportKind::Stdio => mcp_command_is_present(cfg.command.as_deref().unwrap_or("")),
    }
}

/// The program string `Command::new` must be given so `command` can actually spawn on
/// this platform. Identity for every command the probe accepts, except one Windows
/// case.
///
/// Surrounding whitespace is stripped on **all** platforms, because that is the same
/// normalization [`mcp_command_is_present`] applies before it declares a command
/// installed. `mcp_server_config_from_decl` does not trim the declaration's `command`
/// (only its `command_env` override), and a hand-pasted `mcp.json` trims nothing at
/// all, so without this a `"command": "npx "` would clear the gate and then `ENOENT`
/// in `Command::new` — the probe-disagrees-with-spawn bug this function exists to
/// close, one layer up from the Windows one.
///
/// On Windows, `std`'s program resolution appends **only** `.exe` to a bare name and
/// never consults `PATHEXT` (`resolve_exe`'s `path.set_extension("exe")`, verified
/// against the 1.96 toolchain), so `Command::new("npx")` cannot find `npx.cmd`. It
/// *can* run a batch file when the program string itself ends in `.cmd`/`.bat`:
/// `std` detects that (`is_batch_file`) and re-targets the spawn at
/// `cmd.exe /d /c "<script>" <args>`, escaping the args and rejecting only `\r`/`\n`
/// in them (`make_bat_command_line` — the CVE-2024-24576 hardening). So handing it the
/// resolved `…\npx.cmd` path is both necessary and sufficient.
///
/// An **extensionless** `PATH` hit is the same probe-disagrees-with-spawn shape, one
/// case narrower, and it is handled the same way. `which_on_path`'s first probe is the
/// bare `dir.join(program)`, so a `PATH` entry that is a file literally named `npx`
/// with no extension counts as installed (`manifest_sidecar.rs:153-155`) — but by the
/// `set_extension("exe")` rule above, `Command::new("npx")` probes only `npx.exe` per
/// directory and never the extensionless file, so the bare name cannot spawn it. Handing
/// over the resolved path is the only thing that *can*: for a program string containing
/// separators, `resolve_exe` appends `.exe`, and when *that* does not exist it strips it
/// again and hands `CreateProcessW` the path verbatim (`append_suffix` →
/// `program_exists` → `set_extension("")` → `args::to_user_path`, read against the 1.96
/// toolchain). Whether the OS then runs an extensionless image is the OS's business —
/// the rewrite does not depend on it, because the bare name is a *guaranteed* failure
/// here (only `.exe` is ever appended to it), so the resolved path cannot be worse.
///
/// That rewrite is taken **only when no `<name>.exe` exists anywhere on `PATH`**, i.e.
/// only when the bare name provably cannot spawn. Otherwise an extensionless file early
/// on `PATH` (a Git-for-Windows shell script, say) would shadow a real `foo.exe` later
/// on it that the bare name resolves today — a rewrite that broke a working spawn to fix
/// a theoretical one.
///
/// Residual, deliberately not chased here: `resolve_exe` searches the **child's** `PATH`
/// (a `PATH` entry in the server's declared `env`) and Core's own executable directory
/// *before* `PATH`, while both this function and the probe read the parent process's
/// `PATH` only. A `<name>.exe` reachable solely through one of those still resolves for
/// the bare name while we conclude it cannot.
///
/// The root cause is upstream of this module and is a workaround here, not a fix:
/// `which_on_path` probes the bare `dir.join(program)` *before* the `.exe`/`.cmd`/`.bat`
/// candidates (`manifest_sidecar.rs:150-166`), an order `std` never uses for a dotless
/// bare name — it appends `.exe` and looks at nothing else. Reordering (or dropping) that
/// direct probe on Windows for a dotless program is what would make the probe answer the
/// question `Command::new` actually asks.
///
/// Otherwise deliberately narrow, to keep the change to the cases that are broken
/// today:
/// * unix — returns the trimmed `command` and nothing else (`cfg!(windows)` is false),
///   so no `PATH` walk happens on the spawn path there at all;
/// * an `.exe` hit — returns the bare name, preserving late `PATH` binding (an operator
///   can install/replace the binary without a Core restart);
/// * an extensionless hit with a `<name>.exe` elsewhere on `PATH` — same, the bare name
///   still resolves;
/// * a command with a path separator — left as written: `std` does not search `PATH`
///   for it and already batch-dispatches a path ending in `.cmd`/`.bat`;
/// * nothing on `PATH` — left as written, so the spawn fails with the same "not found"
///   error it always did rather than a confusing rewritten one.
pub(crate) fn spawn_program_for(command: &str) -> String {
    spawn_program_with(command, cfg!(windows), |program| {
        crate::sidecar::manifest_sidecar::which_on_path(program)
    })
}

/// [`spawn_program_for`] with the platform bit and the `PATH` lookup injected, so the
/// Windows branch is testable from a unix CI box (the only host this repo's tests run
/// on) instead of being asserted by inspection.
///
/// `lookup` must answer for the exact program string it is given (it is called with the
/// bare name AND, for an extensionless hit, with `<name>.exe`) — the real one,
/// `which_on_path`, does.
fn spawn_program_with(
    command: &str,
    windows: bool,
    lookup: impl Fn(&str) -> Option<std::path::PathBuf>,
) -> String {
    let trimmed = command.trim();
    if !windows || trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') {
        return trimmed.to_owned();
    }
    let Some(resolved) = lookup(trimmed) else {
        return trimmed.to_owned();
    };
    if let Some(shim) = batch_shim_program(&resolved) {
        return shim;
    }
    // Extensionless hit: the bare name resolves ONLY through the `.exe` `std` appends,
    // so fall back to the resolved path when there is no `<name>.exe` on `PATH` at all.
    // Checked in this order so a `.cmd`/`.bat` shim keeps winning (first `PATH` directory
    // wins, as `cmd.exe` itself would) without paying for a second `PATH` walk.
    if resolved.extension().is_none() && lookup(&format!("{trimmed}.exe")).is_none() {
        return resolved.to_string_lossy().into_owned();
    }
    trimmed.to_owned()
}

/// The spawn-program string a `PATH`-resolved path needs, or `None` when the bare
/// command name already spawns. `Some` only for a Windows batch shim (`.cmd`/`.bat`,
/// case-insensitively — `PATH` entries are routinely `NPX.CMD`).
fn batch_shim_program(resolved: &std::path::Path) -> Option<String> {
    let ext = resolved.extension()?.to_str()?;
    (ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        .then(|| resolved.to_string_lossy().into_owned())
}

#[cfg(test)]
#[path = "tests/command_resolve.rs"]
mod tests;

#[cfg(test)]
#[path = "tests/spawn_program.rs"]
mod spawn_program_tests;
