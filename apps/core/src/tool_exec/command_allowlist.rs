//! Command-tool binary allowlist, builtin seeds, and argument templating.
//!
//! Split out of `tool_exec/mod.rs`; items are re-exported there, so
//! `crate::tool_exec::*` paths are unchanged.

use super::*;

/// Parse `RYU_COMMAND_TOOL_ALLOWLIST` (`name=/abs/path` entries separated by `,`
/// or `;`) into a KEY→path map. **Pure** — no env read, no filesystem access, so
/// it is unit-testable without process-global races. Malformed entries (no `=`,
/// empty name, non-absolute path) are skipped; the map is intentionally empty
/// (⇒ fail-closed) for an empty/garbage string.
pub fn parse_command_allowlist(raw: &str) -> BTreeMap<String, std::path::PathBuf> {
    let mut map = BTreeMap::new();
    for entry in raw.split([',', ';']) {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let Some((name, path)) = entry.split_once('=') else {
            continue;
        };
        let name = name.trim();
        let path = path.trim();
        if name.is_empty() || path.is_empty() {
            continue;
        }
        let p = std::path::PathBuf::from(path);
        // Only absolute targets: the allowlist maps a logical key to an exact
        // binary, never a PATH-relative name an attacker could shadow.
        if !p.is_absolute() {
            continue;
        }
        map.insert(name.to_owned(), p);
    }
    map
}

/// Process-global seed of TRUSTED built-in command-tool bins (key → absolute
/// path), populated ONCE from the compiled-in manifests at startup by
/// [`seed_builtin_command_allowlist`]. Merged UNDER the env allowlist in
/// [`resolve_command_bin`] (env wins), so a built-in command tool (spider/rtk) is
/// runnable out of the box while a user can still add/override bins via
/// `RYU_COMMAND_TOOL_ALLOWLIST` — and an untrusted `~/.ryu/plugins` manifest can
/// never self-allowlist a bin (only `load_builtins()` feeds this).
pub(super) static BUILTIN_COMMAND_SEED: std::sync::OnceLock<BTreeMap<String, std::path::PathBuf>> =
    std::sync::OnceLock::new();

/// Resolve a TRUSTED Core-side absolute path for a built-in command-tool bin KEY.
/// The manifest carries only the KEY (path-shaped values are structurally rejected
/// at `resolve_backend`), so the KEY→path mapping is Core-controlled here. Returns
/// a path even when the binary is not installed (so [`resolve_command_bin`] can
/// degrade gracefully to "not installed" rather than fail-closed) — only genuinely
/// unknown built-in keys map to `None`. Honors the same dev-override envs the
/// deleted native providers did (`RYU_SPIDER_BIN`, `RYU_RTK_BIN`).
///
/// # No PATH discovery
///
/// Both arms resolve to an operator-set absolute override or Ryu's OWN
/// `~/.ryu/bin/<name>`, never to a `$PATH` walk. [`parse_command_allowlist`]
/// enforces "only absolute targets — never a PATH-relative name an attacker could
/// shadow" for env-supplied entries, and this seed feeds the SAME allowlist, so it
/// has to honour the same invariant. `rtk` used to fall through to
/// [`crate::rtk_config::rtk_bin_path`], which returns the first `rtk` on `$PATH`
/// (resolved once at startup) — a writable directory earlier on Core's PATH was
/// enough to make an attacker-planted binary the allowlisted `rtk`. That module
/// keeps its PATH probe for the Phase-2 auto-wrap availability check, which spawns
/// `rtk init` for a user-driven toggle rather than admitting a bin to the
/// model-reachable tool allowlist.
pub(super) fn trusted_builtin_bin_path(bin_key: &str) -> Option<std::path::PathBuf> {
    let ryu_bin = || crate::paths::bin_dir();
    match bin_key {
        "spider" => Some(
            std::env::var_os("RYU_SPIDER_BIN")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| ryu_bin().join("spider")),
        ),
        "rtk" => Some(
            std::env::var_os("RYU_RTK_BIN")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| ryu_bin().join("rtk")),
        ),
        "bws" => Some(
            std::env::var_os("RYU_BWS_BIN")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| ryu_bin().join("bws")),
        ),
        _ => None,
    }
}

/// Command-bin keys whose paths are trusted by Core independently of plugin
/// enablement or manifest loading. These plugins are ordinary marketplace
/// packages in production, so they are not necessarily present in
/// `load_builtins()` even though their command keys remain Core-owned trust
/// decisions.
pub(super) const TRUSTED_COMMAND_BIN_KEYS: &[&str] = &["spider", "rtk", "bws"];

/// Compute the built-in command-bin seed map from Core's trusted command keys.
/// This deliberately does not scan manifests: `load_builtins()` is a runtime
/// system-manifest catalog, not the source of truth for command trust. **Pure**
/// (no global mutation): tests call this directly and assert the contents
/// without poisoning the process-global [`BUILTIN_COMMAND_SEED`].
pub fn builtin_command_seed() -> BTreeMap<String, std::path::PathBuf> {
    let mut map = BTreeMap::new();
    for &bin in TRUSTED_COMMAND_BIN_KEYS {
        if let Some(path) = trusted_builtin_bin_path(bin) {
            map.insert(bin.to_owned(), path);
        }
    }
    map
}

/// Seed [`BUILTIN_COMMAND_SEED`] once from Core's trusted command keys. Called
/// from `main.rs` at startup so a granted spider/rtk call resolves out of the
/// box even when their ordinary marketplace manifests are not compiled in.
/// Idempotent; safe to call more than once (only the first wins).
pub fn seed_builtin_command_allowlist() {
    let _ = BUILTIN_COMMAND_SEED.set(builtin_command_seed());
}

/// Merge the built-in seed map with the env allowlist. The env is ADDITIVE and
/// wins on a key collision (so a user can override a built-in path and tests that
/// set the env keep working). **Pure** — takes both maps explicitly.
pub(super) fn merge_command_allowlist(
    seed: &BTreeMap<String, std::path::PathBuf>,
    env_map: BTreeMap<String, std::path::PathBuf>,
) -> BTreeMap<String, std::path::PathBuf> {
    let mut merged = seed.clone();
    for (k, v) in env_map {
        merged.insert(k, v);
    }
    merged
}

/// The outcome of resolving a command-tool bin KEY, splitting the two failure
/// classes the caller must treat differently:
///   - an UNKNOWN key is a fail-closed `Err` (the allowlist IS the security
///     control — a bin nobody trusted must never run);
///   - an allowlisted key whose file is absent/not-a-file is `NotInstalled`, an
///     OPERATIONAL failure the caller degrades to a graceful `{available:false}`.
pub(super) enum BinResolution {
    Ready(std::path::PathBuf),
    NotInstalled(String),
}

/// Resolve a command-tool bin KEY to its absolute path via the merged allowlist
/// (built-in seed ∪ env, env wins), verifying the target is an existing regular
/// file. An UNKNOWN key is refused fail-closed (`Err`); an allowlisted key whose
/// file is missing/not-a-file is [`BinResolution::NotInstalled`] (graceful). THIS
/// is the primary control — a manifest never supplies a path, only a key.
pub(super) fn resolve_command_bin(bin_key: &str) -> Result<BinResolution, String> {
    let raw = std::env::var(ENV_COMMAND_TOOL_ALLOWLIST).unwrap_or_default();
    let env_map = parse_command_allowlist(&raw);
    let seed = BUILTIN_COMMAND_SEED.get().cloned().unwrap_or_default();
    let map = merge_command_allowlist(&seed, env_map);
    let Some(path) = map.get(bin_key) else {
        return Err(format!(
            "command tool: bin '{bin_key}' is not in the command allowlist (set {ENV_COMMAND_TOOL_ALLOWLIST})"
        ));
    };
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() && is_executable_mode(&meta) => {
            Ok(BinResolution::Ready(path.clone()))
        }
        Ok(meta) if meta.is_file() => Ok(BinResolution::NotInstalled(format!(
            "command tool: bin '{bin_key}' path {} is not executable",
            path.display()
        ))),
        Ok(_) => Ok(BinResolution::NotInstalled(format!(
            "command tool: bin '{bin_key}' path {} is not a regular file",
            path.display()
        ))),
        Err(e) => Ok(BinResolution::NotInstalled(format!(
            "command tool: bin '{bin_key}' is not installed at {} ({e})",
            path.display()
        ))),
    }
}

/// True when a regular file's mode lets it be executed (any execute bit on
/// unix; always true elsewhere, where executability is not a mode bit).
pub(super) fn is_executable_mode(meta: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        true
    }
}

/// The soft-unavailable envelope a `command` tool returns instead of an `Err` for
/// an OPERATIONAL failure (not-installed bin, spawn failure, timeout) so the
/// agent's turn continues — mirroring the deleted spider/rtk providers. Security
/// gates (grant / egress / budget / scan / unknown-bin) still fail-closed `Err`.
pub(super) fn command_unavailable(reason: impl Into<String>) -> Value {
    serde_json::json!({
        "available": false,
        "reason": reason.into(),
        "hint": "The command is unavailable (not installed, failed to start, or timed out); install it or retry.",
    })
}

/// Substitute `{name}` placeholders in ONE argv template element from the
/// tool-call `args`. Scalar-only (objects/arrays are rejected via
/// [`scalar_to_string`]); a placeholder with no matching arg is an error; each
/// interpolated value is length-capped and, as an option-injection guard, may not
/// begin with `-` (a leading-dash value could be read as a FLAG by the target
/// bin — argv arrays alone do not prevent that). The template author's own literal
/// text (including a leading `-` in the template, e.g. `--query={q}`) is never
/// guarded — only the interpolated value is.
pub(super) fn render_command_arg(template: &str, args: &Value) -> Result<String, String> {
    let obj = args.as_object();
    let mut out = String::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            // Unbalanced brace: keep the remainder literally.
            out.push_str(&rest[open..]);
            return Ok(out);
        };
        let name = &after[..close];
        // A `{...}` that is not a plausible arg name (empty, or containing `/`) is
        // kept literally — mirrors `url_placeholders`' defensive scan.
        if name.is_empty() || name.contains('/') {
            out.push('{');
            out.push_str(name);
            out.push('}');
            rest = &after[close + 1..];
            continue;
        }
        let value = obj
            .and_then(|o| o.get(name))
            .ok_or_else(|| format!("command tool: missing argument '{name}'"))?;
        let rendered = scalar_to_string(value)
            .ok_or_else(|| format!("command tool: argument '{name}' must be a scalar"))?;
        if rendered.len() > MAX_COMMAND_ARG_LEN {
            return Err(format!(
                "command tool: argument '{name}' exceeds {MAX_COMMAND_ARG_LEN} bytes"
            ));
        }
        if rendered.starts_with('-') {
            return Err(format!(
                "command tool: argument '{name}' may not begin with '-' (option-injection guard)"
            ));
        }
        out.push_str(&rendered);
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    Ok(out)
}
